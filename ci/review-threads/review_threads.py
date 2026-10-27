#!/usr/bin/env python3
"""Merge gate: FAIL if a PR has unresolved review threads.

GitHub's "require conversation resolution" branch-protection toggle is the native way to
do this, but it's admin-only and invisible from inside the repo. This script gives you
the same gate as a portable CI check (and a pre-merge preflight in a ship script): it
counts unresolved review threads and exits non-zero if any remain.

Providers (REVIEW_THREADS_PROVIDER, default auto):
  github   GraphQL `reviewThreads` via gh (authenticated). The default off-CI and whenever
           $GITHUB_SERVER_URL is unset or https://github.com.
  forgejo  Forgejo REST API v1 via stdlib python3 — picked automatically in a CI job whose
           $GITHUB_SERVER_URL is NOT github.com (Forgejo / Gitea Actions). No gh, no jq.
           API base = $GITHUB_API_URL (else $GITHUB_SERVER_URL/api/v1); token = $GH_TOKEN
           (else $GITHUB_TOKEN) — the job token the workflow passes. Same conversation rule
           as ci/ship's Forgejo provider: every review's comments are read; a conversation is
           what Forgejo's UI shows as one: every comment on the same path + line
           (position/original_position), across reviews and commits; a line-less comment is
           its own conversation; it is resolved only when its FIRST comment has `resolver`
           ("Resolve conversation" marks the first comment only).

Reads the PR number from $1 or $PR_NUMBER.

Knobs (env):
  PR_NUMBER                PR number (or pass as $1).
  GH_REPO                  owner/repo (github: default gh's current repo, honored by gh
                           automatically; forgejo: default $GITHUB_REPOSITORY).
  REVIEW_THREADS_PROVIDER  github | forgejo | auto (default). Set `github` on GitHub
                           Enterprise Server, whose $GITHUB_SERVER_URL is not github.com.
  IGNORE_OUTDATED          1 = skip threads GitHub marked outdated (github only; Forgejo has
                           no outdated flag, so there every unresolved conversation counts).

Usage:
  ci/review-threads/review-threads.sh 123
  PR_NUMBER=123 ci/review-threads/review-threads.sh
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

QUERY = """query($owner:String!,$name:String!,$pr:Int!,$endCursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$pr){
      reviewThreads(first:100,after:$endCursor){
        pageInfo{hasNextPage endCursor}
        nodes{isResolved isOutdated}
      }
    }
  }
}"""

# Outdated-but-unresolved still count by default; IGNORE_OUTDATED=1 skips outdated.
_NODES = ".data.repository.pullRequest.reviewThreads.nodes[]"
JQ_ALL = f"[{_NODES} | select(.isResolved|not)] | length"
_LIVE = "select((.isResolved|not) and (.isOutdated|not))"
JQ_NOT_OUTDATED = f"[{_NODES} | {_LIVE}] | length"

LIMIT, MAX_PAGES = 50, 200


class ApiError(Exception):
    """Any failure to read the review conversations (the gate fails closed)."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # Never follow a redirect: the Authorization header must not reach another host.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(
            req.full_url, code, f"redirect to {newurl} refused", headers, fp
        )


_OPENER = urllib.request.build_opener(_NoRedirect)


def _get(url, token):
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "agent-tools-review-threads/1",
        },
    )
    if token:
        req.add_header("Authorization", f"token {token}")
    try:
        with _OPENER.open(req, timeout=30) as resp:
            body, total = resp.read(), resp.headers.get("X-Total-Count")
    except urllib.error.HTTPError as exc:
        raise ApiError(f"Forgejo API GET {url} -> HTTP {exc.code}") from exc
    except (urllib.error.URLError, OSError) as exc:
        raise ApiError(f"Forgejo API GET {url} failed: {exc}") from exc
    try:
        return json.loads(body), total
    except ValueError as exc:
        raise ApiError(f"Forgejo API GET {url} returned non-JSON") from exc


def _get_list(url, token):
    data, _ = _get(url, token)
    if not isinstance(data, list):
        raise ApiError(f"Forgejo API GET {url} did not return a list")
    return data


def _paged(url, token):
    # Stop on X-Total-Count, else on an empty page - never on a short page, so a
    # server whose page cap is below LIMIT cannot truncate the read (a truncated
    # read could hide a thread).
    items = []
    for page in range(1, MAX_PAGES + 1):
        chunk, total = _get(f"{url}?page={page}&limit={LIMIT}", token)
        if not isinstance(chunk, list):
            raise ApiError(f"Forgejo API GET {url} did not return a list")
        if not chunk:
            return items
        items.extend(chunk)
        if total is not None and total.strip().isdigit() and len(items) >= int(total):
            return items
    raise ApiError(
        f"Forgejo API GET {url} exceeded {MAX_PAGES} pages — refusing a truncated read",
    )


def _key(c):
    line = (c.get("position") or 0, c.get("original_position") or 0)
    if line == (0, 0):
        return ("single", c.get("id"))
    # Forgejo's own grouping: every comment on this path + signed line, whatever
    # review or commit it came with, is ONE conversation, resolved through its
    # first comment.
    return (c.get("path") or "", line)


def _forgejo_base(api, repo, pr):
    if not pr.isdigit():
        raise ApiError(f"PR number must be numeric, got {pr!r}")
    owner, _, name = repo.partition("/")
    if not owner or not name or "/" in name:
        raise ApiError(f"repository must be owner/repo, got {repo!r}")
    return (
        f"{api.rstrip('/')}/repos/{urllib.parse.quote(owner, safe='')}/"
        f"{urllib.parse.quote(name, safe='')}/pulls/{pr}"
    )


def _review_comments(base, token):
    """Yield every comment of every review (comment endpoint is not paginated)."""
    for review in _paged(f"{base}/reviews", token):
        rid = review.get("id") if isinstance(review, dict) else None
        if not isinstance(rid, int):
            raise ApiError("Forgejo review without an id — cannot read its comments")
        # Always fetched: comments_count on the list payload is not trusted to
        # skip a review.
        yield from _get_list(f"{base}/reviews/{rid}/comments", token)


def forgejo_unresolved(api, repo, pr, token):
    """Count unresolved Forgejo conversations; raise ApiError on any failure."""
    base = _forgejo_base(api, repo, pr)
    conversations = {}
    for c in _review_comments(base, token):
        if not isinstance(c, dict) or not isinstance(c.get("id"), int):
            raise ApiError(
                "Forgejo review comment without an id — cannot place it in a conversation",
            )
        conversations.setdefault(_key(c), []).append(c)
    # A conversation is resolved only through its FIRST (lowest id) comment.
    return sum(
        1
        for comments in conversations.values()
        if not min(comments, key=lambda c: c["id"]).get("resolver")
    )


def _forgejo(pr):
    api = os.environ.get("GITHUB_API_URL", "")
    if not api:
        server = os.environ.get("GITHUB_SERVER_URL", "")
        if not server:
            raise ApiError("neither GITHUB_API_URL nor GITHUB_SERVER_URL is set")
        api = server.rstrip("/") + "/api/v1"
    repo = os.environ.get("GH_REPO") or os.environ.get("GITHUB_REPOSITORY") or ""
    if not repo:
        raise ApiError("no repository: set GH_REPO or GITHUB_REPOSITORY (owner/repo)")
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
    return forgejo_unresolved(api, repo, pr, token)


def sum_leading_ints(raw):
    """Sum the first whitespace-separated field of each line (awk `s+=$1`)."""
    total = 0
    for line in raw.splitlines():
        m = re.match(r"\s*([+-]?\d+)", line)
        if m:
            total += int(m.group(1))
    return total


def _github(pr, ignore_outdated):
    jq = JQ_NOT_OUTDATED if ignore_outdated else JQ_ALL
    # {owner}/{repo} placeholders let gh fill the current repo (GH_REPO honored).
    argv = [
        "gh", "api", "graphql", "--paginate",
        "-F", "owner={owner}", "-F", "name={repo}", "-F", f"pr={pr}",
        "-f", f"query={QUERY}", "--jq", jq,
    ]  # fmt: skip
    # Fail-CLOSED on an API error: check gh's exit status, not just the count.
    try:
        proc = subprocess.run(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError as exc:
        raise ApiError(f"gh failed: {exc}") from exc
    if proc.returncode != 0:
        raise ApiError("gh api failed")
    return sum_leading_ints(proc.stdout.decode("utf-8", "replace"))


def _provider():
    provider = os.environ.get("REVIEW_THREADS_PROVIDER", "auto") or "auto"
    if provider == "auto":
        server = os.environ.get("GITHUB_SERVER_URL", "").rstrip("/")
        provider = "forgejo" if server and server != "https://github.com" else "github"
    return provider


def _fail_closed(pr, exc, provider):
    # A silent 0 would let an unresolved PR merge.
    if provider == "forgejo":
        print(exc, file=sys.stderr)
        what, via = "conversations", "Forgejo API"
    else:
        what, via = "threads", "gh api"
    print(
        f"::error::could not query review {what} for PR #{pr} ({via} failed) — failing closed.",
        file=sys.stderr,
    )
    print(f"FAIL: review-thread query failed for PR #{pr}.", file=sys.stderr)
    return 1


def _report(pr, unresolved):
    if unresolved != 0:
        print(
            f"::error::PR #{pr} has {unresolved} unresolved review thread(s) "
            "— resolve every thread before merging.",
            file=sys.stderr,
        )
        print(
            f"FAIL: {unresolved} unresolved review thread(s) on PR #{pr}.",
            file=sys.stderr,
        )
        return 1
    print(f"PASS: PR #{pr} has no unresolved review threads.")
    return 0


def main():
    pr = (sys.argv[1] if len(sys.argv) > 1 else "") or os.environ.get("PR_NUMBER", "")
    if not pr:
        script = os.path.join(os.path.dirname(sys.argv[0]), "review-threads.sh")
        print(f"Usage: {script} <pr-number>  (or set PR_NUMBER)", file=sys.stderr)
        return 2

    ignore_outdated = os.environ.get("IGNORE_OUTDATED", "0") == "1"
    provider = _provider()
    if provider not in ("forgejo", "github"):
        print(
            f"unknown REVIEW_THREADS_PROVIDER '{provider}' (github | forgejo | auto)",
            file=sys.stderr,
        )
        return 2
    if provider == "github" and shutil.which("gh") is None:
        print("gh CLI not found", file=sys.stderr)
        return 2
    if provider == "forgejo" and ignore_outdated:
        print(
            "note: IGNORE_OUTDATED=1 has no Forgejo equivalent (the API has no "
            "outdated flag) — counting every unresolved conversation.",
            file=sys.stderr,
        )
    try:
        if provider == "forgejo":
            unresolved = _forgejo(pr)
        else:
            unresolved = _github(pr, ignore_outdated)
    except ApiError as exc:
        return _fail_closed(pr, exc, provider)
    return _report(pr, unresolved)


if __name__ == "__main__":
    sys.exit(main())

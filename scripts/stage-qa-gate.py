#!/usr/bin/env python3
"""Ship gate: refuse to merge a PR unless Stage QA passed for its exact current head (ExpenseSyncBot).

Why it reads so much: a commit status can be posted by anyone with write access (or a PR
workflow that forges one), so "green" is only accepted when the status is bound to a
`workflow_run` run of the trusted QA workflow, on the same head, in this repository.

Exit codes: 0 green (or gate inactive during bootstrap), 1 not green (fix hint printed),
2 the gate could not evaluate (GitHub/gh error) - never a silent pass.
"""
import argparse
import json
import re
import subprocess
import sys

QA_WORKFLOW_PATH = ".github/workflows/stage-qa.yml"
QA_CONTEXT = "stage-qa"
QA_JOB_NAME = "Stage QA run"
BOT_LOGIN = "github-actions[bot]"
PAGE_SIZE = 100
MAX_PAGES = 20
DESCRIPTION = re.compile(r"^passed cases=([1-9][0-9]*) run=([1-9][0-9]*)$")
SHA = re.compile(r"^[0-9a-f]{40}$")


class NotGreen(Exception):
    pass


class CannotEvaluate(Exception):
    pass


def gh(*args):
    try:
        done = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as error:
        raise CannotEvaluate(f"cannot run gh: {error}") from error
    return done


def gh_json(*args):
    done = gh(*args)
    if done.returncode != 0:
        detail = (done.stderr.strip().splitlines() or ["no error output"])[-1]
        raise CannotEvaluate(f"gh {' '.join(args[:2])} failed: {detail}")
    try:
        return json.loads(done.stdout)
    except ValueError as error:
        raise CannotEvaluate(f"gh {' '.join(args[:2])} returned invalid JSON") from error


def workflow_exists_on_default_branch(repo):
    done = gh("api", f"repos/{repo}/contents/{QA_WORKFLOW_PATH}")
    if done.returncode == 0:
        return True
    if re.search(r"HTTP 404\b", done.stderr):
        return False
    detail = (done.stderr.strip().splitlines() or ["no error output"])[-1]
    raise CannotEvaluate(f"cannot check {QA_WORKFLOW_PATH} on the default branch: {detail}")


def newest_qa_status(repo, head):
    # Statuses come newest first; the first stage-qa entry is the effective one.
    for page in range(1, MAX_PAGES + 1):
        batch = gh_json("api", f"repos/{repo}/commits/{head}/statuses?per_page={PAGE_SIZE}&page={page}")
        if not isinstance(batch, list):
            raise CannotEvaluate("statuses response is not a list")
        for status in batch:
            if isinstance(status, dict) and status.get("context") == QA_CONTEXT:
                return status
        if len(batch) < PAGE_SIZE:
            return None
    raise CannotEvaluate(f"more than {MAX_PAGES * PAGE_SIZE} statuses on {head[:12]}; cannot find {QA_CONTEXT}")


def full_name(value):
    return value.get("full_name") if isinstance(value, dict) else None


def evaluate(repo, pr):
    info = gh_json(
        "pr", "view", str(pr), "--repo", repo,
        "--json", "state,isDraft,headRefOid,isCrossRepository",
    )
    head = info.get("headRefOid")
    if not isinstance(head, str) or not SHA.match(head):
        raise CannotEvaluate("PR head sha missing from gh pr view")
    if info.get("state") != "OPEN":
        raise NotGreen(f"PR #{pr} is {info.get('state')}, not open. Only open PRs can be shipped.")
    if info.get("isDraft"):
        raise NotGreen(f"PR #{pr} is a draft. Mark it ready for review, then wait for Stage QA on the new head.")
    if info.get("isCrossRepository"):
        raise NotGreen(f"PR #{pr} comes from a fork. Stage QA never runs fork code; push the branch to {repo} instead.")

    status = newest_qa_status(repo, head)
    short = head[:12]
    if status is None:
        raise NotGreen(
            f"No `{QA_CONTEXT}` status on head {short}. The `Stage Bot` workflow has not finished for this commit, "
            f"Stage QA was superseded by another PR taking the shared stage slot, or the head moved: wait for "
            f"`Stage QA`, or re-run the `Stage Bot` workflow of this PR (it redeploys the head and QA follows)."
        )
    state = status.get("state")
    url = status.get("target_url") or "(no run URL)"
    if state == "pending":
        raise NotGreen(f"`{QA_CONTEXT}` is still pending on head {short}: wait for Stage Bot / Stage QA to finish ({url}), then retry.")
    if state == "error":
        raise NotGreen(
            f"`{QA_CONTEXT}` could not run on head {short}: {status.get('description')!r} ({url}). "
            f"Re-run the `Stage Bot` workflow of this PR; if it keeps failing, the QA infrastructure needs a fix."
        )
    if state != "success":
        raise NotGreen(f"`{QA_CONTEXT}` is {state} on head {short} ({url}). Fix the failure and push a new commit; Stage QA reruns on the new head.")

    creator = (status.get("creator") or {}).get("login")
    if creator != BOT_LOGIN:
        raise NotGreen(f"`{QA_CONTEXT}` was posted by {creator!r}, not {BOT_LOGIN}: it is not trusted. Let the Stage QA workflow post it by re-running it.")
    match = DESCRIPTION.match(status.get("description") or "")
    if not match:
        raise NotGreen(f"`{QA_CONTEXT}` description {status.get('description')!r} is not `passed cases=<n> run=<id>`: not a real QA result; re-run Stage QA.")
    run_id = match.group(2)
    expected_url = f"https://github.com/{repo}/actions/runs/{run_id}"
    if status.get("target_url") != expected_url:
        raise NotGreen(f"`{QA_CONTEXT}` target_url {status.get('target_url')!r} is not {expected_url}: the status is not bound to its QA run; re-run Stage QA.")

    run = gh_json("api", f"repos/{repo}/actions/runs/{run_id}")
    problems = []
    if run.get("path") != QA_WORKFLOW_PATH:
        problems.append(f"workflow path is {run.get('path')!r}, expected {QA_WORKFLOW_PATH}")
    if run.get("event") != "workflow_run":
        problems.append(f"event is {run.get('event')!r}, expected workflow_run")
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        problems.append(f"run is {run.get('status')}/{run.get('conclusion')}, expected completed/success")
    if run.get("head_sha") != head:
        problems.append(f"run head_sha {str(run.get('head_sha'))[:12]} differs from PR head {short}")
    for key in ("repository", "head_repository"):
        if full_name(run.get(key)) != repo:
            problems.append(f"{key} is {full_name(run.get(key))!r}, expected {repo}")
    if problems:
        raise NotGreen(f"`{QA_CONTEXT}` run {run_id} is not a trusted QA run: " + "; ".join(problems) + ". Re-run Stage QA from the PR.")

    jobs = gh_json("api", f"repos/{repo}/actions/runs/{run_id}/jobs?per_page=100")
    job_list = jobs.get("jobs") if isinstance(jobs, dict) else None
    if not isinstance(job_list, list):
        raise CannotEvaluate("jobs response has no jobs list")
    qa_jobs = [j for j in job_list if isinstance(j, dict) and j.get("name") == QA_JOB_NAME]
    if not qa_jobs or any(j.get("conclusion") != "success" for j in qa_jobs):
        raise NotGreen(f"Run {run_id} has no successful `{QA_JOB_NAME}` job ({expected_url}); re-run Stage QA.")
    return head, int(match.group(1)), run_id


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", required=True)
    parser.add_argument("--pr", required=True, type=int)
    args = parser.parse_args(argv)
    try:
        if not workflow_exists_on_default_branch(args.repo):
            print(
                f"stage-qa gate inactive: {QA_WORKFLOW_PATH} does not exist on the default branch of "
                f"{args.repo} yet (bootstrap). Stage QA is NOT enforced for this ship."
            )
            return 0
        head, cases, run_id = evaluate(args.repo, args.pr)
    except NotGreen as error:
        print(f"stage-qa gate: NOT GREEN. {error}", file=sys.stderr)
        return 1
    except CannotEvaluate as error:
        print(f"stage-qa gate: cannot evaluate ({error}). Fix gh access/network and retry; refusing to ship blind.", file=sys.stderr)
        return 2
    print(f"stage-qa gate: green for {head[:12]} cases={cases} run={run_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

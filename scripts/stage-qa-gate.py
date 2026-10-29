#!/usr/bin/env python3
"""Ship gate: refuse to merge a PR unless Stage QA passed for its exact current head (ExpenseSyncBot).

Why it reads so much: a commit status can be posted by anyone with write access (or a PR
workflow that forges one), so "green" is only accepted when the status is bound to a
`workflow_run` run of the trusted QA workflow, produced from the default branch of this
repository, whose QA job really tested the PR head.

Why the tested head comes from the job log. Stage QA is a `workflow_run` workflow: GitHub always
runs the copy on the default branch, and the REST run object reports the default branch commit as
its head_sha, with empty `pull_requests` and `referenced_workflows`. The tested PR head is only an
event value the workflow injects into the QA step as `HEAD_SHA`. The one record of it that the PR
cannot write is the step header the runner puts at the top of the job log (`##[group]Run ...`, the
script, `shell:`, an `env:` block with `HEAD_SHA: <40 hex>`, `##[endgroup]`) before the trusted
shell executes anything. The gate reads that header of the first trusted step, `Run the stage QA
through qa-cli` (jobs API steps: 1 `Set up job`, 2 that step), and requires its single `HEAD_SHA`
to equal the current PR head. Only the first header counts: whatever the driver prints later is
not read. Only the head of the log is read (LOG_HEAD_LIMIT) and it stays in memory; error texts
never contain log lines, only fixed words and a validated short SHA.

The verdict itself is also tied to the run: any PR workflow can post a status as github-actions[bot],
so the status must have been created while the run's own `Post stage-qa` job was executing - and
that window is only corroboration, since a forged status can land inside it. The authority is the
step header of the report job's first trusted step, `Post the stage-qa status`, read the same way:
its env block carries the workflow's own inputs of the verdict (HEAD_SHA, RUN_ID, BOT_CONCLUSION,
QA_RESULT, QA_RC, QA_CASES), and the gate requires them to say "this run passed this head with
exactly the case count the status reports". A forged status cannot change that header. The
log read needs a gh that knows `--allow-escape-sequences` (the log carries ANSI colour); an older
gh fails the read and the gate refuses with exit 2. The binding assumes the workflow passes the
QA step no PR-controlled text in its env (today only HEAD_SHA, pinned by a test).

Exit codes: 0 green (or gate inactive during bootstrap), 1 not green (fix hint printed),
2 the gate could not evaluate (GitHub/gh error, unreadable or unrecognised log) - never a silent pass.
"""

import argparse
import json
import re
import subprocess
import sys
import threading
from datetime import datetime, timezone

QA_WORKFLOW_PATH = ".github/workflows/stage-qa.yml"
QA_CONTEXT = "stage-qa"
QA_JOB_NAME = "Stage QA run"
SETUP_STEP_NAME = "Set up job"
QA_STEP_NAME = "Run the stage QA through qa-cli"
REPORT_STEP_NAME = "Post the stage-qa status"
REPORT_JOB_NAME = "Post stage-qa"
BOT_LOGIN = "github-actions[bot]"
PAGE_SIZE = 100
MAX_PAGES = 20
DESCRIPTION = re.compile(r"^passed cases=([1-9][0-9]*) run=([1-9][0-9]*)$")
SHA = re.compile(r"^[0-9a-f]{40}$")
TIMESTAMP = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")

# The runner's header of the first trusted step sits in the first few KiB of the log; the driver's
# own output follows and can be megabytes, so only the head is ever read.
LOG_HEAD_LIMIT = 256 * 1024
LOG_DEADLINE_SECONDS = 60
LOG_LINE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{7}Z (.*)$")
HEADER_START = "##[group]Run "
GROUP_END = "##[endgroup]"
HEAD_SHA_DECLARATION = re.compile(r"^\s*HEAD_SHA\s*:")
HEAD_SHA_ENV_LINE = re.compile(r"^  HEAD_SHA: ([0-9a-f]{40})$")
ENV_LINE = re.compile(r"^  ([A-Z][A-Z0-9_]*): (.*)$")
VERDICT_ENV_NAMES = ("HEAD_SHA", "RUN_ID", "BOT_CONCLUSION", "QA_RESULT", "QA_RC", "QA_CASES")


class NotGreen(Exception):
    pass


class CannotEvaluate(Exception):
    pass


def gh(*args):
    try:
        done = subprocess.run(
            ["gh", *args], capture_output=True, text=True, timeout=60, check=False
        )
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
        batch = gh_json(
            "api", f"repos/{repo}/commits/{head}/statuses?per_page={PAGE_SIZE}&page={page}"
        )
        if not isinstance(batch, list):
            raise CannotEvaluate("statuses response is not a list")
        for status in batch:
            if isinstance(status, dict) and status.get("context") == QA_CONTEXT:
                return status
        if len(batch) < PAGE_SIZE:
            return None
    raise CannotEvaluate(
        f"more than {MAX_PAGES * PAGE_SIZE} statuses on {head[:12]}; cannot find {QA_CONTEXT}"
    )


def full_name(value):
    return value.get("full_name") if isinstance(value, dict) else None


def open_pr_head(repo, pr):
    """The head sha of PR `pr`, which must be an open, non-draft PR from this repository."""
    info = gh_json(
        "pr",
        "view",
        str(pr),
        "--repo",
        repo,
        "--json",
        "state,isDraft,headRefOid,isCrossRepository",
    )
    head = info.get("headRefOid")
    if not isinstance(head, str) or not SHA.match(head):
        raise CannotEvaluate("PR head sha missing from gh pr view")
    if info.get("state") != "OPEN":
        raise NotGreen(f"PR #{pr} is {info.get('state')}, not open. Only open PRs can be shipped.")
    if info.get("isDraft"):
        raise NotGreen(
            f"PR #{pr} is a draft. Mark it ready for review, then wait for Stage QA on the new head."
        )
    if info.get("isCrossRepository"):
        raise NotGreen(
            f"PR #{pr} comes from a fork. Stage QA never runs fork code; push the branch to {repo} instead."
        )
    return head


def require_success_status(status, head):
    """The newest stage-qa status of the head must exist and be `success`."""
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
        raise NotGreen(
            f"`{QA_CONTEXT}` is still pending on head {short}: wait for Stage Bot / Stage QA to finish ({url}), then retry."
        )
    if state == "error":
        raise NotGreen(
            f"`{QA_CONTEXT}` could not run on head {short}: {status.get('description')!r} ({url}). "
            f"Re-run the `Stage Bot` workflow of this PR; if it keeps failing, the QA infrastructure needs a fix."
        )
    if state != "success":
        raise NotGreen(
            f"`{QA_CONTEXT}` is {state} on head {short} ({url}). Fix the failure and push a new commit; Stage QA reruns on the new head."
        )


def bind_status_to_run(status, repo):
    """The status must come from the Actions bot and point at its own QA run; return (cases, run_id, run_url)."""
    creator = (status.get("creator") or {}).get("login")
    if creator != BOT_LOGIN:
        raise NotGreen(
            f"`{QA_CONTEXT}` was posted by {creator!r}, not {BOT_LOGIN}: it is not trusted. Let the Stage QA workflow post it by re-running it."
        )
    match = DESCRIPTION.match(status.get("description") or "")
    if not match:
        raise NotGreen(
            f"`{QA_CONTEXT}` description {status.get('description')!r} is not `passed cases=<n> run=<id>`: not a real QA result; re-run Stage QA."
        )
    run_id = int(match.group(2))
    expected_url = f"https://github.com/{repo}/actions/runs/{run_id}"
    if status.get("target_url") != expected_url:
        raise NotGreen(
            f"`{QA_CONTEXT}` target_url {status.get('target_url')!r} is not {expected_url}: the status is not bound to its QA run; re-run Stage QA."
        )
    return int(match.group(1)), run_id, expected_url


def default_branch_name(repo):
    info = gh_json("api", f"repos/{repo}")
    name = info.get("default_branch") if isinstance(info, dict) else None
    if not isinstance(name, str) or not name:
        raise CannotEvaluate("repository response has no default_branch")
    return name


def run_problems(run, run_id, repo, default_branch):
    """Every way the run differs from a completed, successful QA workflow_run of the default branch.

    The run's own head_sha is deliberately not compared with the PR head: for a workflow_run it is
    the default branch commit. The tested head is bound through the job log (require_log_binds_head).
    """
    problems = []
    if run.get("id") != run_id:
        problems.append(f"run id is {run.get('id')!r}, expected {run_id}")
    if run.get("path") != QA_WORKFLOW_PATH:
        problems.append(f"workflow path is {run.get('path')!r}, expected {QA_WORKFLOW_PATH}")
    if run.get("event") != "workflow_run":
        problems.append(f"event is {run.get('event')!r}, expected workflow_run")
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        problems.append(
            f"run is {run.get('status')}/{run.get('conclusion')}, expected completed/success"
        )
    if run.get("head_branch") != default_branch:
        problems.append(
            f"head_branch is {run.get('head_branch')!r}, expected the default branch {default_branch!r}"
        )
    for key in ("repository", "head_repository"):
        if full_name(run.get(key)) != repo:
            problems.append(f"{key} is {full_name(run.get(key))!r}, expected {repo}")
    return problems


def require_trusted_run(repo, run_id):
    """The run object of the status, which must be a trusted default-branch QA run; returns it."""
    run = gh_json("api", f"repos/{repo}/actions/runs/{run_id}")
    if not isinstance(run, dict):
        raise CannotEvaluate("run response is not an object")
    default_branch = default_branch_name(repo)
    problems = run_problems(run, run_id, repo, default_branch)
    if problems:
        raise NotGreen(
            f"`{QA_CONTEXT}` run {run_id} is not a trusted QA run: "
            + "; ".join(problems)
            + ". Re-run Stage QA from the PR."
        )
    return run


def qa_step_problems(job):
    return step_problems(job, QA_STEP_NAME)


def report_step_problems(job):
    return step_problems(job, REPORT_STEP_NAME)


def step_problems(job, step_name):
    """The steps the log binding relies on: the runner's `Set up job`, then the exact trusted step."""
    steps = job.get("steps")
    if not isinstance(steps, list) or len(steps) < 2:
        return ["the job lists fewer than two steps"]
    setup, qa = steps[0], steps[1]
    if not isinstance(setup, dict) or not isinstance(qa, dict):
        return ["the job steps are not objects"]
    problems = []
    if (setup.get("number"), setup.get("name")) != (1, SETUP_STEP_NAME):
        problems.append(f"step 1 is not `{SETUP_STEP_NAME}`")
    if (qa.get("number"), qa.get("name")) != (2, step_name):
        problems.append(f"step 2 is not `{step_name}`")
    if qa.get("status") != "completed" or qa.get("conclusion") != "success":
        problems.append(
            f"step 2 is {qa.get('status')}/{qa.get('conclusion')}, expected completed/success"
        )
    return problems


def is_count(value):
    return isinstance(value, int) and not isinstance(value, bool)


def job_problems(job, run):
    """Every way a job differs from a completed, successful job of this run.

    The attempt may be older than the run's: "re-run failed jobs" keeps the earlier successful QA
    job and only repeats the report job, and the status then belongs to the later attempt.
    """
    problems = []
    if job.get("run_id") != run.get("id"):
        problems.append(f"job belongs to run {job.get('run_id')!r}, not {run.get('id')}")
    attempt = job.get("run_attempt")
    if (
        not is_count(attempt)
        or not is_count(run.get("run_attempt"))
        or not 1 <= attempt <= run["run_attempt"]
    ):
        problems.append("job is not of an attempt of this run")
    if job.get("status") != "completed" or job.get("conclusion") != "success":
        problems.append(
            f"job is {job.get('status')}/{job.get('conclusion')}, expected completed/success"
        )
    if not is_count(job.get("id")):
        problems.append("job has no numeric id")
    return problems


def require_one_successful_job(job_list, name, run, run_url, extra_problems):
    """The one job called `name` in the run's job list, completed and successful; returns it."""
    run_id = run.get("id")
    matching = [j for j in job_list if isinstance(j, dict) and j.get("name") == name]
    if len(matching) != 1:
        raise NotGreen(
            f"Run {run_id} has {len(matching)} `{name}` jobs, expected exactly one successful ({run_url}); re-run Stage QA."
        )
    problems = job_problems(matching[0], run) + extra_problems(matching[0])
    if problems:
        raise NotGreen(
            f"Run {run_id} has no successful `{name}` job ({run_url}): "
            + "; ".join(problems)
            + "; re-run all jobs of Stage QA."
        )
    return matching[0]


def require_run_jobs(repo, run, run_url):
    """The successful QA job and the successful report job of the run; returns (qa_job, report_job)."""
    jobs = gh_json("api", f"repos/{repo}/actions/runs/{run.get('id')}/jobs?per_page=100")
    job_list = jobs.get("jobs") if isinstance(jobs, dict) else None
    if not isinstance(job_list, list):
        raise CannotEvaluate("jobs response has no jobs list")
    qa_job = require_one_successful_job(job_list, QA_JOB_NAME, run, run_url, qa_step_problems)
    report_job = require_one_successful_job(
        job_list, REPORT_JOB_NAME, run, run_url, report_step_problems
    )
    return qa_job, report_job


def job_time(value, what):
    if not isinstance(value, str) or not TIMESTAMP.match(value):
        raise CannotEvaluate(f"{what} has no usable timestamp")
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError as error:
        raise CannotEvaluate(f"{what} has no usable timestamp") from error


def require_status_from_report_job(status, report_job, run_url):
    """The status must have been created while the run's own report job was executing.

    The report job is the only writer of the verdict. A pull request workflow can post a status as
    github-actions[bot] too, so the creator alone proves little; a forged one would have to land
    inside the few seconds the report job runs, and cannot pose as a verdict of a run that never
    posted one (the QA step passing with no case, a later failed run).
    """
    created = job_time(status.get("created_at"), f"the `{QA_CONTEXT}` status")
    started = job_time(report_job.get("started_at"), f"the `{REPORT_JOB_NAME}` job")
    finished = job_time(report_job.get("completed_at"), f"the `{REPORT_JOB_NAME}` job")
    if not started <= created <= finished:
        raise NotGreen(
            f"`{QA_CONTEXT}` was not created by the `{REPORT_JOB_NAME}` job of {run_url} (outside its run time): "
            f"it was not posted by the workflow; re-run Stage QA."
        )


def failure_reason(code, detail, expired):
    if expired.is_set():
        return f"gh did not finish within {LOG_DEADLINE_SECONDS}s"
    status = re.search(rb"HTTP ([0-9]{3})", detail)
    return f"HTTP {status.group(1).decode()}" if status else f"gh exit {code}"


def read_job_log_head(repo, job_id):
    """(prefix, capped): the first LOG_HEAD_LIMIT bytes of the job log, kept in memory.

    gh follows the signed redirect itself. A capped prefix ends at a line boundary, so a cut can
    never leave half a line; a failed or killed gh is only accepted when the cap was reached.
    """
    command = ["gh", "api", "--allow-escape-sequences", f"repos/{repo}/actions/jobs/{job_id}/logs"]
    try:
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as error:
        raise CannotEvaluate(f"cannot run gh: {error}") from error
    expired = threading.Event()

    def stop():
        expired.set()
        proc.kill()

    watchdog = threading.Timer(LOG_DEADLINE_SECONDS, stop)
    watchdog.start()
    try:
        prefix = proc.stdout.read(LOG_HEAD_LIMIT + 1)
        capped = len(prefix) > LOG_HEAD_LIMIT
        if capped:
            proc.kill()
        detail = b"" if capped else proc.stderr.read(65536)
        code = proc.wait()
    finally:
        watchdog.cancel()
        proc.kill()
        proc.stdout.close()
        proc.stderr.close()
    if capped:
        cut = prefix[:LOG_HEAD_LIMIT]
        return cut[: cut.rfind(b"\n") + 1], True
    if code != 0:
        raise CannotEvaluate(
            f"cannot read the log of job {job_id}: {failure_reason(code, detail, expired)}"
        )
    return prefix, False


def log_texts(raw):
    """The runner's log lines without BOM, CR and timestamp; any other line shape is not runner output."""
    text = raw.decode("utf-8", errors="replace")
    lines = (text[1:] if text.startswith("\ufeff") else text).split("\n")
    if lines[-1] == "":
        lines.pop()
    for line in lines:
        match = LOG_LINE.match(line[:-1] if line.endswith("\r") else line)
        if match is None:
            raise CannotEvaluate("the job log is not in the runner's timestamped line format")
        yield match.group(1)


def first_step_header(texts, capped):
    """The lines of the first `##[group]Run ` group: the runner's own header of the first trusted step."""
    header = None
    for text in texts:
        if header is None:
            header = [] if text.startswith(HEADER_START) else None
        elif text == GROUP_END:
            return header
        else:
            header.append(text)
    if header is None and not capped:
        raise NotGreen("the job log has no step header")
    raise CannotEvaluate(
        f"no complete step header within the first {LOG_HEAD_LIMIT // 1024} KiB of the job log"
    )


def header_head_sha(header):
    """The one `HEAD_SHA` the runner printed in the env block of the step header."""
    shell = next((i for i, text in enumerate(header) if text.startswith("shell: ")), None)
    if shell is None or header[shell + 1 : shell + 2] != ["env:"]:
        raise NotGreen("the step header has no env block")
    declared = [i for i, text in enumerate(header) if HEAD_SHA_DECLARATION.match(text)]
    if len(declared) != 1 or declared[0] < shell + 2:
        raise NotGreen(
            f"the step header declares HEAD_SHA {len(declared)} times, expected exactly once in its env block"
        )
    match = HEAD_SHA_ENV_LINE.match(header[declared[0]])
    if match is None:
        raise NotGreen("HEAD_SHA in the step header is not a full lowercase commit SHA")
    return match.group(1)


def job_step_header(repo, job_id):
    prefix, capped = read_job_log_head(repo, job_id)
    if not prefix.strip():
        raise CannotEvaluate(f"the log of job {job_id} is empty")
    return first_step_header(log_texts(prefix), capped)


def tested_head_sha(repo, job_id):
    return header_head_sha(job_step_header(repo, job_id))


def header_env(header, names):
    """The value of each of `names` printed once in the env block of the step header."""
    shell = next((i for i, text in enumerate(header) if text.startswith("shell: ")), None)
    if shell is None or header[shell + 1 : shell + 2] != ["env:"]:
        raise NotGreen("the step header has no env block")
    declared = {}
    for text in header[shell + 2 :]:
        match = ENV_LINE.match(text)
        if match is not None:
            declared.setdefault(match.group(1), []).append(match.group(2))
    for name in names:
        if len(declared.get(name, [])) != 1:
            raise NotGreen(
                f"the step header declares {name} {len(declared.get(name, []))} times, expected exactly once in its env block"
            )
    return {name: declared[name][0] for name in names}


def require_log_binds_head(repo, job, head, run_url):
    """The QA job must have been started by the runner with the PR head as its HEAD_SHA."""
    tested = tested_head_sha(repo, job["id"])
    if tested != head:
        raise NotGreen(
            f"Stage QA ({run_url}) tested {tested[:12]}, not the PR head {head[:12]}: "
            f"the result belongs to another commit; re-run Stage QA from the PR."
        )


def require_report_says_passed(repo, report_job, head, run_id, cases, run_url):
    """The report step must have been started by the runner with inputs that make `passed cases=N` the verdict."""
    env = header_env(job_step_header(repo, report_job["id"]), VERDICT_ENV_NAMES)
    expected = {
        "HEAD_SHA": head,
        "RUN_ID": str(run_id),
        "BOT_CONCLUSION": "success",
        "QA_RESULT": "success",
        "QA_RC": "0",
        "QA_CASES": str(cases),
    }
    wrong = sorted(name for name in VERDICT_ENV_NAMES if env[name] != expected[name])
    if wrong:
        raise NotGreen(
            f"The `{REPORT_JOB_NAME}` job of {run_url} did not report a pass of this head with {cases} cases "
            f"(its {', '.join(wrong)} disagree): the status was not the workflow's verdict; re-run Stage QA."
        )


def require_head_unmoved(repo, pr, head):
    """The PR head can move while the evidence is read; the verdict is for the head it was asked about."""
    if open_pr_head(repo, pr) != head:
        raise NotGreen(
            f"PR #{pr} head moved from {head[:12]} while the gate was reading; retry on the new head."
        )


def evaluate(repo, pr):
    head = open_pr_head(repo, pr)
    status = newest_qa_status(repo, head)
    require_success_status(status, head)
    cases, run_id, run_url = bind_status_to_run(status, repo)
    run = require_trusted_run(repo, run_id)
    qa_job, report_job = require_run_jobs(repo, run, run_url)
    require_status_from_report_job(status, report_job, run_url)
    require_log_binds_head(repo, qa_job, head, run_url)
    require_report_says_passed(repo, report_job, head, run_id, cases, run_url)
    require_head_unmoved(repo, pr, head)
    return head, cases, run_id


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
        print(
            f"stage-qa gate: cannot evaluate ({error}). Fix gh access/network and retry; refusing to ship blind.",
            file=sys.stderr,
        )
        return 2
    print(f"stage-qa gate: green for {head[:12]} cases={cases} run={run_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

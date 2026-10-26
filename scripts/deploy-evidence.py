#!/usr/bin/env python3
"""Keep pm2 logs and failure evidence on the host around a deploy's `pm2 reload`.

Why (owner requirement 7, "evidence saved before anything is replaced"): the same
2026-10-24 incident that cost HyperCalendarBot the logs of a rolled-back release showed that a
deploy here replaces the running apps with nothing kept about the outgoing ones, and that a
release which did not come up leaves only the job log. deploy.yml therefore calls this before it
rotates or reloads anything and again, first of all, when the release did not come up:

  release-logs  copy the last --tail-mb of every app's current out/error log, gzipped, to
                <logs-root>/release-<label>-<stamp>/ (label = outgoing revision, 12 chars)
  failed        save a bounded, redacted evidence bundle of a release that did not come up to
                <logs-root>/failed-<sha12>-<stamp>/ and print `EVIDENCE_DIR=<path>`

Accessed via: .github/workflows/deploy.yml (the `deploy` step, under `timeout 300`) and by hand
on the odroid as www-data. scripts/log-retention.py is the only thing that ever deletes these
directories: it spares the newest release-* (last deploy) and failed-* (last failure).

Assumptions:
  * Best effort by design: nothing raises into the deploy (exit status is 0 unless the arguments
    are wrong), because losing evidence is bad but blocking a reload is worse. Every external
    command is bounded by --command-timeout, so the whole run cannot wait on a wedged pm2.
  * Directories are 0700 and files 0600: pm2 logs hold chat traffic. The failed bundle's text
    files are redacted (tokens, keys, passwords, message text fields, the chat-message log lines); release-* holds raw log
    tails and stays private. The live log files are only read, never moved or changed.
  * Process summaries are an allow-list of pm2_env keys (scripts/deploy_pm2.py): the environment
    of the apps holds every production secret and is never copied.
"""

import argparse
import datetime
import gzip
import json
import os
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
import deploy_pm2  # noqa: E402  (a sibling file; must follow dont_write_bytecode)

TAIL_LINES = 400
TAIL_MAX_BYTES = 256 * 1024
TAIL_READ_BYTES = 2 * 1024 * 1024
COPY_CHUNK = 1024 * 1024

SECRET_PATTERNS = [
    # No \b before the digits: in a bot URL they follow the literal "bot" (".../bot123456789:TOKEN/...").
    (re.compile(r"(?<![0-9])\d{6,12}:[A-Za-z0-9_-]{30,}"), "[telegram-token]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"), "[jwt]"),
    (re.compile(r"\b(?:sk|pk|gh[pousr]|glpat|xox[abp])[-_][A-Za-z0-9_-]{16,}\b"), "[api-key]"),
    # Google OAuth access tokens and API keys, which this bot's Sheets integration logs around.
    (re.compile(r"\bya29\.[A-Za-z0-9_-]{16,}"), "[google-token]"),
    (re.compile(r"\bAIza[A-Za-z0-9_-]{30,}"), "[google-key]"),
    (re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}"), "Bearer [redacted]"),
    (re.compile(
        r"""(?i)(["']?(?:password|passwd|secret|token|api[_-]?key|encryption[_-]?key|private[_-]?key|authorization|cookie|session[_-]?string)["']?\s*[:=]\s*)(["']?)[^\s"',}&]+"""
    ), r"\1\2[redacted]"),
    (re.compile(r"://([^/\s:@]*):[^/\s@]+@"), r"://\1:[redacted]@"),
]
# Message content must not be copied: blank the value of these JSON string fields.
CONTENT_FIELD = re.compile(
    r'("(?:text|caption|prompt|content|query|transcript|body|message_text|question|answer|description|merchant|comment|input|reply)"\s*:\s*)"(?:[^"\\]|\\.)*"'
)
# A field whose value is an array or object (`"content":[...]`, `"content":{"text":...}`): the nesting
# cannot be matched with a regex, so the rest of that log line goes.
CONTENT_STRUCTURE = re.compile(
    r'("(?:text|caption|prompt|content|query|transcript|body|message_text|question|answer|description|merchant|comment|input|reply)"\s*:\s*)[\[{].*$',
    re.MULTILINE,
)
# pino's own `msg` carries user text where the handlers log it in the message: the raw text of every
# incoming chat message (message.handler.ts) and the validators' verdict over a user's reply.
MESSAGE_WITH_USER_TEXT = re.compile(r'("msg"\s*:\s*)"\[(?:MSG|VALIDATOR|ADVICE-VALIDATOR)\](?:[^"\\]|\\.)*"')
HIGH_LEVEL = re.compile(r'"level"\s*:\s*(?:5\d|[6-9]\d)\b')


def redact(text):
    text = CONTENT_FIELD.sub(r'\1"[redacted]"', text)
    text = CONTENT_STRUCTURE.sub(r'\1"[redacted]"', text)
    text = MESSAGE_WITH_USER_TEXT.sub(r'\1"[redacted]"', text)
    for pattern, replacement in SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")


def make_dir(root, name):
    path = Path(root) / name
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.chmod(0o700)
    return path


def write_private(path, data):
    mode = "wb" if isinstance(data, bytes) else "w"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, mode) as handle:
        handle.write(data)


def best_effort(what, action):
    """Run one part of the bundle; a failure is reported and the other parts still get saved."""
    try:
        return action()
    except Exception as error:
        print(f"deploy-evidence: {what} not saved ({type(error).__name__})", file=sys.stderr)
        return None


def copy_tail_gz(source, target, max_bytes):
    """gzip the last `max_bytes` of `source` into `target`, starting on a line boundary.

    Reads at most the size seen at the start, so a log that keeps growing cannot make the copy
    unbounded. Returns the size of the gz.
    """
    with open(source, "rb") as src:
        size = os.fstat(src.fileno()).st_size
        skipped = max(0, size - max_bytes)
        if skipped:
            src.seek(skipped - 1)
            src.readline()  # finish the line the cut landed in; a cut exactly on a boundary loses nothing
            if src.tell() >= size:
                src.seek(skipped)  # the whole window is one giant line: keep its raw bytes rather than nothing
        remaining = size - src.tell()
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", compresslevel=6) as out:
            while remaining > 0:
                chunk = src.read(min(remaining, COPY_CHUNK))
                if not chunk:
                    break
                out.write(chunk)
                remaining -= len(chunk)
    return os.path.getsize(target)


def tail_lines(path, count):
    """Last `count` lines of a file, reading at most TAIL_READ_BYTES from its end."""
    with open(path, "rb") as handle:
        size = os.fstat(handle.fileno()).st_size
        start = max(0, size - TAIL_READ_BYTES)
        handle.seek(start)
        lines = handle.read(TAIL_READ_BYTES).decode("utf-8", errors="replace").splitlines(keepends=True)
    if start and lines:
        lines = lines[1:]  # the first line is cut in the middle
    return lines[-count:]


def log_sources(processes, apps):
    """(app, stream, path) for each wanted app's out and error log, as pm2 itself names them."""
    seen = set()
    for name in apps:
        process = deploy_pm2.find(processes, name)
        if process is None:
            continue
        env = deploy_pm2.pm2_env(process)
        for stream, key in (("out", "pm_out_log_path"), ("err", "pm_err_log_path")):
            path = env.get(key)
            if path and path not in seen:
                seen.add(path)
                yield name, stream, path


def summaries(processes, apps):
    return [deploy_pm2.summarize(p) for p in (deploy_pm2.find(processes, name) for name in apps) if p]


def host_snapshot(logs_root, timeout):
    parts = []
    for label, path in (("loadavg", "/proc/loadavg"), ("pressure/io", "/proc/pressure/io"),
                        ("pressure/memory", "/proc/pressure/memory"), ("pressure/cpu", "/proc/pressure/cpu")):
        try:
            parts.append(f"## {label}\n{Path(path).read_text()}")
        except OSError:
            parts.append(f"## {label}\n(unavailable)\n")
    for label, cmd in (("free -m", ["free", "-m"]), ("uptime", ["uptime"]),
                       (f"df -h {logs_root}", ["df", "-h", str(logs_root)]), ("df -h /", ["df", "-h", "/"]),
                       ("vmstat 1 2", ["vmstat", "1", "2"])):
        _, out, err = deploy_pm2.run(cmd, timeout)
        parts.append(f"## {label}\n{out or err}")
    return "\n".join(parts)


def logs_index(logs_root):
    """Names, sizes and times of what sits in the logs directory; no content."""
    rows = []
    with os.scandir(logs_root) as it:
        for item in sorted(it, key=lambda entry: entry.name):
            info = item.stat(follow_symlinks=False)
            when = datetime.datetime.fromtimestamp(info.st_mtime, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            kind = "dir " if item.is_dir(follow_symlinks=False) else "file"
            rows.append(f"{kind} {info.st_size:>12} {when}Z {item.name}")
    return "\n".join(rows) + "\n"


def state_line(summary, level50plus):
    uptime = summary.get("pm_uptime")
    up_seconds = int(datetime.datetime.now().timestamp() - uptime / 1000) if isinstance(uptime, (int, float)) else "?"
    memory = summary.get("memory")
    memory_mb = int(memory / 1024 / 1024) if isinstance(memory, (int, float)) else "?"
    return (
        f"{summary.get('name')} pid={summary.get('pid')} status={summary.get('status')} "
        f"restarts={summary.get('restart_time')} unstable_restarts={summary.get('unstable_restarts')} "
        f"uptime_s={up_seconds} memory_mb={memory_mb} level50plus_in_tail={level50plus}"
    )


def cmd_release_logs(args):
    directory = make_dir(args.logs_root, f"release-{args.label}-{stamp()}")
    processes = deploy_pm2.pm2_processes(args.pm2, args.command_timeout)
    total = 0
    if processes is None:
        write_private(directory / "note.txt", "pm2 unavailable: its log paths are unknown, no log was copied\n")
    else:
        write_private(directory / "processes.json", json.dumps(summaries(processes, args.app), indent=2) + "\n")
        max_bytes = int(args.tail_mb * 1024 * 1024)
        for app, stream, path in log_sources(processes, args.app):
            if not os.path.isfile(path) or os.path.getsize(path) == 0:
                continue
            copied = best_effort(f"{app} {stream} log", lambda: copy_tail_gz(path, directory / f"{app}.{stream}.log.gz", max_bytes))
            total += copied or 0
    print(f"RELEASE_LOGS dir={directory} bytes={total}")


def cmd_failed(args):
    directory = make_dir(args.logs_root, f"failed-{args.sha[:12]}-{stamp()}")
    processes = deploy_pm2.pm2_processes(args.pm2, args.command_timeout)
    state = []
    if processes is None:
        state.append("pm2 unavailable: process state and log paths could not be read")
    else:
        write_private(directory / "processes.json", json.dumps(summaries(processes, args.app), indent=2) + "\n")
        tails = {}
        for app, stream, path in log_sources(processes, args.app):
            def save(app=app, stream=stream, path=path):
                text = redact("".join(tail_lines(path, args.tail_lines)))[-TAIL_MAX_BYTES:]
                write_private(directory / f"{app}.{stream}.tail.redacted.log", text)
                return len(HIGH_LEVEL.findall(text))
            tails[app] = tails.get(app, 0) + (best_effort(f"{app} {stream} log tail", save) or 0)
        for app in args.app:
            process = deploy_pm2.find(processes, app)
            state.append(state_line(deploy_pm2.summarize(process), tails.get(app, 0)) if process else f"{app} missing from the pm2 list")
    write_private(directory / "state.txt", "\n".join(state) + "\n")
    if args.verdict_log and Path(args.verdict_log).is_file():
        best_effort("verdict log", lambda: write_private(directory / "verdict.log", redact(Path(args.verdict_log).read_text(errors="replace"))))
    best_effort("logs index", lambda: write_private(directory / "logs-index.txt", logs_index(args.logs_root)))
    best_effort("host load", lambda: write_private(directory / "host-load.txt", redact(host_snapshot(args.logs_root, args.command_timeout))))
    print(f"EVIDENCE_DIR={directory}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("release-logs", "failed"):
        command = sub.add_parser(name)
        command.add_argument("--pm2", default="pm2", help="pm2 binary")
        command.add_argument("--logs-root", required=True)
        command.add_argument("--app", action="append", required=True, help="pm2 app name; repeatable")
        command.add_argument("--command-timeout", type=float, default=30.0, help="seconds each pm2/host command may take")
    release = sub.choices["release-logs"]
    release.add_argument("--label", required=True, help="short revision of the outgoing release")
    release.add_argument("--tail-mb", type=float, default=16.0, help="keep at most this much of the end of each log")
    failed = sub.choices["failed"]
    failed.add_argument("--sha", required=True)
    failed.add_argument("--tail-lines", type=int, default=TAIL_LINES)
    failed.add_argument("--verdict-log", default="", help="file with the health verdict's output, saved redacted")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,80}", getattr(args, "label", None) or getattr(args, "sha", None) or ""):
        parser.error("label/sha must be a short plain token")
    try:
        {"release-logs": cmd_release_logs, "failed": cmd_failed}[args.command](args)
    except Exception as error:  # evidence is best effort and must never block a reload
        print(f"deploy-evidence: command {args.command} failed ({type(error).__name__})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

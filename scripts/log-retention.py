#!/usr/bin/env python3
"""Log retention for /opt/hypercal/logs: rotate by size AND free disk, never by deploy or rollback.

Accessed via: a systemd timer / cron on the odroid (as root) running `log-retention.py --root
<logs dir> --alert`; deploy and rollback scripts never call it and never delete logs themselves, so
the evidence of a failed release always survives until this script's limits genuinely force it out.

Managed set (everything else under --root, e.g. chats/, is never touched and never counted):
top-level healthcheck*.log*, backup*.log*, *.log and *.log.gz files, and top-level release-* and
failed-* directories (deploy evidence; one entry each, size = sum of their files, age = dir mtime).

--only-glob PATTERN (repeatable) narrows this: only top-level files whose basename matches a pattern
are managed, and release-*/failed-* dirs only if they match a pattern or --manage-evidence-dirs is
given. Use it where a writer (pm2) holds the CURRENT log open: gzip-then-unlink or deleting that
file would silently lose everything written after, so only the writer's rotated files are named,
e.g. --only-glob '*__*.log' --only-glob '*__*.log.gz'.

Order of work: gzip old/large plain files in place, then evaluate the criteria (managed bytes, entry
count, free disk, per-file size). Only when one is violated are the oldest entries deleted, one at
a time, re-evaluating after each, until all hold.

Assumptions:
  * Never deleted, whatever the violation: the newest release-* (last deploy), the newest failed-*
    (last failure) and anything modified in the last 5 minutes (a log still being written). When only
    protected entries are left the script stops, exits 2 and (with --alert) says so.
  * --root is a real directory, not a symlink and not "/"; symlinks inside it are skipped, and every
    deletion re-checks that the resolved path is inside the resolved root.
  * Compression keeps the original's mtime, mode and owner on the .gz so the age ordering that drives
    deletion does not change just because a file was compressed.

Exit status: 0 criteria hold at the end, 2 violated and unfixable, 3 --root refused, 64 usage.
Free space can be faked for tests via LOG_RETENTION_FREE_BYTES_FILE (a file holding the free byte count).
"""

import argparse
import contextlib
import dataclasses
import fnmatch
import gzip
import hashlib
import json
import os
import re
import shutil
import socket
import stat
import sys
import time

MB = 1024 * 1024
DAY = 86400
RECENT_SECONDS = 300
ALERT_INTERVAL_SECONDS = 6 * 3600
EARLY_WARNING_FACTOR = 2
CHUNK = 1024 * 1024
STATE_FILE_NAME = ".log-retention-state.json"
DEFAULT_ENV_FILE = "/opt/hypercal/.env"

MANAGED_FILE_PATTERNS = ("healthcheck*.log*", "backup*.log*", "*.log", "*.log.gz")
LAST_DEPLOY, LAST_FAILURE, RECENT = "last-deploy", "last-failure", "recent"
EVIDENCE_DIR_PATTERNS = {"release-*": LAST_DEPLOY, "failed-*": LAST_FAILURE}
# Top-level compression is limited to plain log names so a rotated healthcheck.log.zst is not wrapped twice;
# evidence-dir members are compressed unless they already carry a compressed (or our temp) suffix.
TOP_LEVEL_COMPRESSIBLE = re.compile(r"\.log(\.\d+)?$")
ALREADY_COMPRESSED_SUFFIXES = (".gz", ".tgz", ".bz2", ".xz", ".zst", ".zip", ".tmp")

VIOLATION_ORDER = ("file-size", "size", "files", "free")
DELETION_REASONS = ("size", "files", "free")


class RootRefused(Exception):
    """--root is unsafe to operate on."""


class CompressionError(Exception):
    """The gzip copy could not be proven identical to the original."""


@dataclasses.dataclass(frozen=True)
class Config:
    max_dir_bytes: int = 1024 * MB
    max_file_bytes: int = 200 * MB
    max_files: int = 400
    min_free_bytes: int = 2048 * MB
    min_free_percent: float = 5.0
    gzip_after_seconds: float = 1 * DAY
    # Narrowing for callers whose writer keeps the CURRENT log open (pm2): see the module docstring.
    only_globs: tuple = ()
    manage_evidence_dirs: bool = False


@dataclasses.dataclass
class FileInfo:
    path: str
    size: int
    mtime: float


@dataclasses.dataclass
class Entry:
    path: str
    kind: str  # "file" or "dir"
    size: int
    mtime: float
    files: list
    protected: str = None


@dataclasses.dataclass
class Action:
    kind: str  # compressed | compress-failed | deleted | delete-failed | kept
    path: str
    reason: str = None
    bytes: int = None
    protected: str = None
    detail: str = None
    dry_run: bool = False


@dataclasses.dataclass
class Report:
    root: str
    dry_run: bool
    actions: list
    initial_violations: list
    violations: list
    free_bytes: int
    total_bytes: int
    managed_bytes: int
    managed_entries: int

    @property
    def exit_code(self):
        return 2 if self.violations else 0

    @property
    def status(self):
        return "violated" if self.violations else "ok"

    def count(self, kind):
        return sum(1 for a in self.actions if a.kind == kind)

    @property
    def freed_bytes(self):
        return sum(a.bytes or 0 for a in self.actions if a.kind == "deleted")

    def lines(self):
        prefix = "DRY-RUN " if self.dry_run else ""
        lines = []
        for a in self.actions:
            if a.kind == "compressed":
                lines.append(f"{prefix}COMPRESSED {a.path}")
            elif a.kind == "compress-failed":
                lines.append(f"{prefix}COMPRESS_FAILED {a.path} {a.detail}")
            elif a.kind == "deleted":
                lines.append(f"{prefix}DELETED {a.path} reason={a.reason} bytes={a.bytes}")
            elif a.kind == "delete-failed":
                lines.append(f"{prefix}DELETE_FAILED {a.path} reason={a.reason} {a.detail}")
            elif a.kind == "kept":
                lines.append(f"{prefix}KEPT {a.path} protected={a.protected}")
        remaining = ",".join(self.violations) or "none"
        lines.append(
            f"{prefix}SUMMARY status={self.status} exit={self.exit_code} compressed={self.count('compressed')} "
            f"deleted={self.count('deleted')} freed_bytes={self.freed_bytes} violations={remaining} "
            f"managed_bytes={self.managed_bytes} managed_entries={self.managed_entries} free_bytes={self.free_bytes}"
        )
        return lines

    def to_dict(self):
        return {
            "root": self.root,
            "dry_run": self.dry_run,
            "status": self.status,
            "exit_code": self.exit_code,
            "initial_violations": self.initial_violations,
            "violations": self.violations,
            "compressed": self.count("compressed"),
            "deleted": self.count("deleted"),
            "freed_bytes": self.freed_bytes,
            "managed_bytes": self.managed_bytes,
            "managed_entries": self.managed_entries,
            "free_bytes": self.free_bytes,
            "total_bytes": self.total_bytes,
            "actions": [{k: v for k, v in dataclasses.asdict(a).items() if v not in (None, False)} for a in self.actions],
        }


# --- safety -----------------------------------------------------------------------------------


def validate_root(root):
    """Return the resolved root, or raise RootRefused for anything a retention sweep must not touch."""
    text = os.fspath(root)
    if not text.strip():
        raise RootRefused("empty root")
    # islink() is False for "link/" (trailing slash resolves the link), so strip it before the check.
    stripped = text.rstrip(os.sep) or os.sep
    if os.path.islink(stripped):
        raise RootRefused("root is a symlink")
    real = os.path.realpath(stripped)
    if real == os.sep:
        raise RootRefused("root is the filesystem root")
    if not os.path.isdir(real):
        raise RootRefused("root is not an existing directory")
    return real


def _assert_inside(root_real, path):
    real = os.path.realpath(path)
    if real == root_real or os.path.commonpath([root_real, real]) != root_real:
        raise RootRefused("path escapes the root")
    if os.path.islink(path):
        raise RootRefused("path is a symlink")


# --- scanning ---------------------------------------------------------------------------------


def _is_recent(mtime, now):
    # A future mtime is "recent" too: whoever wrote it is still active or the clock is wrong.
    return now - mtime < RECENT_SECONDS


def _walk_files(directory, files):
    with os.scandir(directory) as it:
        for item in it:
            try:
                if item.is_symlink():
                    continue
                if item.is_dir(follow_symlinks=False):
                    _walk_files(item.path, files)
                elif item.is_file(follow_symlinks=False):
                    st = item.stat(follow_symlinks=False)
                    files.append(FileInfo(item.path, st.st_size, st.st_mtime))
            except FileNotFoundError:
                continue


def _is_evidence_dir(name):
    return any(fnmatch.fnmatchcase(name, pattern) for pattern in EVIDENCE_DIR_PATTERNS)


def _is_managed_file(name, cfg):
    patterns = cfg.only_globs or MANAGED_FILE_PATTERNS
    return any(fnmatch.fnmatchcase(name, p) for p in patterns)


def _is_managed_dir(name, cfg):
    if not _is_evidence_dir(name):
        return False
    if not cfg.only_globs or cfg.manage_evidence_dirs:
        return True
    return any(fnmatch.fnmatchcase(name, p) for p in cfg.only_globs)


def _scan_entry(item, cfg):
    """The managed Entry for one top-level directory item, or None (symlinks and unmanaged names)."""
    if item.is_symlink():
        return None
    st = item.stat(follow_symlinks=False)
    if item.is_file(follow_symlinks=False):
        if not _is_managed_file(item.name, cfg):
            return None
        return Entry(item.path, "file", st.st_size, st.st_mtime, [FileInfo(item.path, st.st_size, st.st_mtime)])
    if item.is_dir(follow_symlinks=False) and _is_managed_dir(item.name, cfg):
        files = []
        _walk_files(item.path, files)
        return Entry(item.path, "dir", sum(f.size for f in files), st.st_mtime, files)
    return None


def _has_recent_activity(entry, now):
    return _is_recent(entry.mtime, now) or any(_is_recent(f.mtime, now) for f in entry.files)


def _assign_protection(entries, now):
    for pattern, label in EVIDENCE_DIR_PATTERNS.items():
        group = [e for e in entries if e.kind == "dir" and fnmatch.fnmatchcase(os.path.basename(e.path), pattern)]
        if group:
            max(group, key=lambda e: (e.mtime, e.path)).protected = label
    for entry in entries:
        if entry.protected is None and _has_recent_activity(entry, now):
            entry.protected = RECENT


def scan_root(root_real, now, cfg):
    """Return the managed entries under root with protection already assigned."""
    entries = []
    with os.scandir(root_real) as it:
        for item in it:
            try:
                entry = _scan_entry(item, cfg)
            except FileNotFoundError:
                continue
            if entry is not None:
                entries.append(entry)
    _assign_protection(entries, now)
    return entries


# --- compression ------------------------------------------------------------------------------


def _sha256(opener, path):
    digest = hashlib.sha256()
    with opener(path, "rb") as handle:
        while chunk := handle.read(CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def _gz_matches_source(gz_path, source_path):
    return _sha256(gzip.open, gz_path) == _sha256(open, source_path)


def _fsync_dir(directory):
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def gzip_in_place(path, verify=_gz_matches_source):
    """Replace `path` with `path.gz`; the original is removed only after `verify(gz, original)` is true.

    Any failure leaves the original untouched and no .gz or temp file behind. Mode, owner and mtime
    are carried over to the .gz.
    """
    target = path + ".gz"
    tmp = target + ".tmp"
    if os.path.lexists(target):
        raise FileExistsError(target)
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode):
        raise CompressionError("not a regular file")
    with contextlib.suppress(FileNotFoundError):
        os.unlink(tmp)
    try:
        with open(path, "rb") as source, open(tmp, "xb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=int(before.st_mtime)) as gz:
                shutil.copyfileobj(source, gz, CHUNK)
            raw.flush()
            os.fsync(raw.fileno())
        os.chmod(tmp, stat.S_IMODE(before.st_mode))
        with contextlib.suppress(OSError):  # only root can chown; a non-root run keeps its own owner
            os.chown(tmp, before.st_uid, before.st_gid)
        os.utime(tmp, ns=(before.st_atime_ns, before.st_mtime_ns))
        os.replace(tmp, target)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(tmp)
        raise
    try:
        verified = verify(target, path)
        after = os.lstat(path)
        # A writer appended while we compressed: the gz is a stale copy, so the original must stay.
        if (after.st_size, after.st_mtime_ns) != (before.st_size, before.st_mtime_ns):
            verified = False
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(target)
        raise
    if not verified:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(target)
        raise CompressionError("verification failed")
    os.unlink(path)
    _fsync_dir(os.path.dirname(path))
    return target


@contextlib.contextmanager
def _preserving_dir_mtime(directory):
    """Creating/removing files bumps the directory mtime, which would make an old evidence dir look new."""
    st = os.lstat(directory)
    try:
        yield
    finally:
        with contextlib.suppress(OSError):
            os.utime(directory, ns=(st.st_atime_ns, st.st_mtime_ns))


def _is_compression_candidate(entry, info, cfg, now):
    name = os.path.basename(info.path)
    if entry.kind == "file":
        if not TOP_LEVEL_COMPRESSIBLE.search(name):
            return False
    elif name.endswith(ALREADY_COMPRESSED_SUFFIXES):
        return False
    if _is_recent(info.mtime, now):
        return False
    return now - info.mtime > cfg.gzip_after_seconds or info.size > cfg.max_file_bytes


def _compression_candidates(entries, cfg, now):
    return [(entry, info) for entry in entries for info in entry.files if _is_compression_candidate(entry, info, cfg, now)]


# --- criteria and deletion --------------------------------------------------------------------


def default_free_space(root):
    """(free_bytes, total_bytes) of the filesystem holding root, or the test override in the env."""
    usage = shutil.disk_usage(root)
    override = os.environ.get("LOG_RETENTION_FREE_BYTES_FILE")
    if override:
        with open(override) as handle:
            return int(handle.read().strip()), usage.total
    return usage.free, usage.total


def _free_below_floor(free, total, cfg):
    return free < cfg.min_free_bytes or (total > 0 and free * 100 / total < cfg.min_free_percent)


def _evaluate(entries, cfg, free, total):
    violated = []
    if any(f.size > cfg.max_file_bytes for e in entries for f in e.files):
        violated.append("file-size")
    if sum(e.size for e in entries) > cfg.max_dir_bytes:
        violated.append("size")
    if len(entries) > cfg.max_files:
        violated.append("files")
    if _free_below_floor(free, total, cfg):
        violated.append("free")
    return violated


def _file_protection(entry, info, now):
    if entry.protected in (LAST_DEPLOY, LAST_FAILURE):
        return entry.protected
    return RECENT if _is_recent(info.mtime, now) else None


def _oversized_file_victim(entries, cfg, skip, now):
    over = [
        (info, entry)
        for entry in entries
        for info in entry.files
        if info.path not in skip and info.size > cfg.max_file_bytes and not _file_protection(entry, info, now)
    ]
    if not over:
        return None
    info, entry = min(over, key=lambda pair: (pair[0].mtime, pair[0].path))
    return entry, info, "file-size"


def _pick_victim(entries, cfg, violated, skip, now):
    """Return (entry, file_or_None, reason) for the next deletion, or None when nothing may be deleted.

    A single-file violation costs only that file; the other criteria cost the oldest whole entry.
    """
    if "file-size" in violated:
        victim = _oversized_file_victim(entries, cfg, skip, now)
        if victim is not None:
            return victim
    reasons = [v for v in violated if v in DELETION_REASONS]
    if not reasons:
        return None
    candidates = [e for e in entries if e.protected is None and e.path not in skip]
    if not candidates:
        return None
    return min(candidates, key=lambda e: (e.mtime, e.path)), None, reasons[0]


def _delete_entry(root_real, entry):
    _assert_inside(root_real, entry.path)
    if entry.kind == "dir":
        shutil.rmtree(entry.path)
    else:
        os.unlink(entry.path)


def _delete_member(root_real, info):
    _assert_inside(root_real, info.path)
    with _preserving_dir_mtime(os.path.dirname(info.path)):
        os.unlink(info.path)


def _compress_one(root_real, path, compress):
    parent = os.path.dirname(path)
    if parent == root_real:
        return compress(path)
    with _preserving_dir_mtime(parent):
        return compress(path)


def _compress_pass(root_real, entries, cfg, now, dry_run, compress, actions):
    """Gzip what is old or oversized (or just report it on a dry run); True when any file changed."""
    compressed_any = False
    for _entry, info in _compression_candidates(entries, cfg, now):
        if dry_run:
            actions.append(Action("compressed", info.path, dry_run=True))
            continue
        try:
            _compress_one(root_real, info.path, compress)
        except Exception as exc:  # the original is intact on any failure; report and carry on
            actions.append(Action("compress-failed", info.path, detail=type(exc).__name__))
        else:
            actions.append(Action("compressed", info.path))
            compressed_any = True
    return compressed_any


class _FreeSpace:
    """Free-space reader; a dry run credits the bytes its simulated deletions would free."""

    def __init__(self, free_fn, root_real, dry_run):
        self.free_fn = free_fn
        self.root_real = root_real
        self.dry_run = dry_run
        self.freed_simulated = 0

    def read(self):
        free, total = self.free_fn(self.root_real)
        return free + (self.freed_simulated if self.dry_run else 0), total


def _remove_victim(root_real, entry, info, whole):
    if whole:
        _delete_entry(root_real, entry)
    else:
        _delete_member(root_real, info)


def _skip_failed(skip, entry, info, whole):
    skip.add(entry.path)
    skip.update(f.path for f in entry.files if whole)
    if info is not None:
        skip.add(info.path)


def _delete_victim(root_real, victim, entries, skip, dry_run, actions):
    """Delete (or simulate deleting) one victim; returns the bytes freed, 0 when the deletion failed."""
    entry, info, reason = victim
    whole = info is None or len(entry.files) == 1
    path = entry.path if whole else info.path
    nbytes = entry.size if whole else info.size
    try:
        if not dry_run:
            _remove_victim(root_real, entry, info, whole)
    except (OSError, RootRefused) as exc:
        actions.append(Action("delete-failed", path, reason=reason, detail=type(exc).__name__))
        _skip_failed(skip, entry, info, whole)
        return 0
    actions.append(Action("deleted", path, reason=reason, bytes=nbytes, dry_run=dry_run))
    if whole:
        entries.remove(entry)
    else:
        entry.files.remove(info)
        entry.size -= info.size
    return nbytes


def _run(root, cfg, free_fn, now, dry_run, compress):
    root_real = validate_root(root)
    now = time.time() if now is None else now
    entries = scan_root(root_real, now, cfg)
    actions = []

    if _compress_pass(root_real, entries, cfg, now, dry_run, compress, actions):
        entries = scan_root(root_real, now, cfg)

    space = _FreeSpace(free_fn, root_real, dry_run)
    free, total = space.read()
    violated = _evaluate(entries, cfg, free, total)
    initial = list(violated)
    skip = set()
    while violated:
        victim = _pick_victim(entries, cfg, violated, skip, now)
        if victim is None:
            break
        freed = _delete_victim(root_real, victim, entries, skip, dry_run, actions)
        if dry_run and freed:
            space.freed_simulated += freed
        free, total = space.read()
        violated = _evaluate(entries, cfg, free, total)

    if initial:
        for entry in sorted(entries, key=lambda e: e.path):
            if entry.protected:
                actions.append(Action("kept", entry.path, protected=entry.protected))
    return Report(
        root=root_real,
        dry_run=dry_run,
        actions=actions,
        initial_violations=initial,
        violations=violated,
        free_bytes=free,
        total_bytes=total,
        managed_bytes=sum(e.size for e in entries),
        managed_entries=len(entries),
    )


def plan(root, cfg=None, free_fn=default_free_space, now=None):
    """Simulate a sweep: what would be compressed/deleted. Touches nothing."""
    return _run(root, cfg or Config(), free_fn, now, True, None)


def apply(root, cfg=None, free_fn=default_free_space, now=None, compress=gzip_in_place):
    """Run a sweep for real. `free_fn(root) -> (free, total)` is re-read after every deletion."""
    return _run(root, cfg or Config(), free_fn, now, False, compress)


# --- alerting ---------------------------------------------------------------------------------


class MissingCredentials(Exception):
    """BOT_TOKEN or BOT_ADMIN_ID absent from the env file."""


def parse_env_file(path):
    values = {}
    with open(path) as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.startswith("export "):
                line = line[len("export "):].lstrip()
            key, _, value = line.partition("=")
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            values[key.strip()] = value
    return values


def telegram_send(token, chat_id, text):
    """POST one message. Callers print only the exception class: its text can carry the token-bearing URL."""
    import urllib.parse
    import urllib.request

    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode(),
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=15):
        pass


def alert_findings(report, cfg):
    """Alert kind -> human line, for everything worth telling the operator about this run."""
    findings = {}
    deleted = report.count("deleted")
    if deleted:
        findings["deleted"] = f"deleted {deleted} entries, freed {report.freed_bytes // MB} MB"
    percent = report.free_bytes * 100 / report.total_bytes if report.total_bytes else 100.0
    state = f"free space {report.free_bytes // MB} MB ({percent:.1f}%)"
    floor = f"floor {cfg.min_free_bytes // MB} MB / {cfg.min_free_percent:g}%"
    if "free" in report.violations:
        findings["free-below-floor"] = f"{state} is below the {floor} even after cleanup"
    elif report.free_bytes < EARLY_WARNING_FACTOR * cfg.min_free_bytes or percent < EARLY_WARNING_FACTOR * cfg.min_free_percent:
        findings["free-early-warning"] = f"disk-space watchdog: {state} is within {EARLY_WARNING_FACTOR}x of the {floor}"
    other = [v for v in report.violations if v != "free"]
    if other:
        findings["unresolved"] = f"limits still exceeded with only protected entries left: {', '.join(other)}"
    return findings


def _load_state(path):
    try:
        with open(path) as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, (int, float))}


def _write_state(path, state):
    tmp = path + ".tmp"
    with open(tmp, "w") as handle:
        json.dump(state, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def send_alert(report, cfg, env_file, state_file, now, sender=telegram_send):
    """Send one combined message for the alert kinds not already sent in the last 6 hours.

    Returns {"sent": [...], "suppressed": [...], "failed": exception class name or None}. A failure never
    raises, and leaves the state untouched so the next run retries.
    """
    findings = alert_findings(report, cfg)
    result = {"sent": [], "suppressed": [], "failed": None}
    if not findings:
        return result
    state = _load_state(state_file)
    # A recorded time in the future (clock stepped back) must not mute the alert for hours.
    due = [k for k in findings if not 0 <= now - state.get(k, float("-inf")) < ALERT_INTERVAL_SECONDS]
    result["suppressed"] = [k for k in findings if k not in due]
    if not due:
        return result
    try:
        credentials = parse_env_file(env_file)
        token, chat_id = credentials.get("BOT_TOKEN"), credentials.get("BOT_ADMIN_ID")
        if not token or not chat_id:
            raise MissingCredentials()
        text = "\n".join([f"log-retention on {socket.gethostname()} ({report.root})"] + [f"- {findings[k]}" for k in due])
        sender(token, chat_id, text)
    except Exception as exc:  # report the class only; messages from urllib can embed the URL
        result["failed"] = type(exc).__name__
        return result
    for kind in due:
        state[kind] = now
    try:
        _write_state(state_file, state)
    except OSError as exc:
        result["state_error"] = type(exc).__name__
    result["sent"] = due
    return result


# --- CLI --------------------------------------------------------------------------------------


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's default status 2 would read as "limits violated"; usage errors get their own code.
        self.print_usage(sys.stderr)
        self.exit(64, f"{self.prog}: error: {message}\n")


def _non_negative_float(text):
    value = float(text)
    if value < 0:
        raise argparse.ArgumentTypeError("must be >= 0")
    return value


def _non_negative_int(text):
    value = int(text)
    if value < 0:
        raise argparse.ArgumentTypeError("must be >= 0")
    return value


def build_parser():
    parser = _Parser(description="Rotate deploy/health/backup logs by size and free disk; never by deploy.")
    parser.add_argument("--root", required=True, help="logs directory to manage")
    parser.add_argument("--max-dir-mb", type=_non_negative_float, default=1024)
    parser.add_argument("--max-file-mb", type=_non_negative_float, default=200)
    parser.add_argument("--max-files", type=_non_negative_int, default=400)
    parser.add_argument("--min-free-mb", type=_non_negative_float, default=2048)
    parser.add_argument("--min-free-percent", type=_non_negative_float, default=5)
    parser.add_argument("--gzip-after-days", type=_non_negative_float, default=1)
    parser.add_argument("--alert", action="store_true", help="send a Telegram message (needs BOT_TOKEN, BOT_ADMIN_ID)")
    parser.add_argument("--env-file", default=DEFAULT_ENV_FILE)
    parser.add_argument("--state-file", default=None, help="alert rate-limit state (default <root>/.log-retention-state.json)")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument(
        "--only-glob",
        action="append",
        default=[],
        metavar="PATTERN",
        help=(
            "repeatable; manage ONLY top-level files whose basename matches a pattern (fnmatch), replacing "
            "the default file patterns. release-*/failed-* dirs are then unmanaged unless they match a "
            "pattern or --manage-evidence-dirs is given"
        ),
    )
    parser.add_argument(
        "--manage-evidence-dirs",
        action="store_true",
        help="with --only-glob: also manage release-*/failed-* dirs (they are always managed without --only-glob)",
    )
    return parser


def config_from_args(args):
    return Config(
        max_dir_bytes=int(args.max_dir_mb * MB),
        max_file_bytes=int(args.max_file_mb * MB),
        max_files=args.max_files,
        min_free_bytes=int(args.min_free_mb * MB),
        min_free_percent=float(args.min_free_percent),
        gzip_after_seconds=args.gzip_after_days * DAY,
        only_globs=tuple(args.only_glob),
        manage_evidence_dirs=args.manage_evidence_dirs,
    )


def _print_text_report(report, alert, out):
    for line in report.lines():
        print(line, file=out)
    if alert is None:
        return
    if alert["failed"]:
        print(f"ALERT_FAILED {alert['failed']}", file=out)
    if alert.get("state_error"):
        print(f"ALERT_STATE_FAILED {alert['state_error']}", file=out)


def _print_json_report(report, alert, out):
    document = report.to_dict()
    if alert is not None:
        document["alert"] = alert
    print(json.dumps(document, indent=2), file=out)


def main(argv=None, *, free_fn=None, sender=None, now=None, out=None, err=None):
    out = sys.stdout if out is None else out
    err = sys.stderr if err is None else err
    args = build_parser().parse_args(argv)
    cfg = config_from_args(args)
    free_fn = free_fn or default_free_space
    now = time.time() if now is None else now
    try:
        root_real = validate_root(args.root)
    except RootRefused as exc:
        print(f"REFUSED {exc}", file=err)
        return 3

    run = plan if args.dry_run else apply
    report = run(root_real, cfg, free_fn=free_fn, now=now)

    alert = None
    if args.alert and not args.dry_run:
        state_file = args.state_file or os.path.join(root_real, STATE_FILE_NAME)
        alert = send_alert(report, cfg, args.env_file, state_file, now, sender or telegram_send)

    if args.json:
        _print_json_report(report, alert, out)
    else:
        _print_text_report(report, alert, out)
    return report.exit_code


if __name__ == "__main__":
    sys.exit(main())

# Deployment Guide for ExpenseSyncBot

The bot runs on a home server (**odroidn2**, Odroid N2, Armbian, aarch64). Public HTTPS
traffic enters through Cloudflare: the Cloudflare Tunnel `odroid-home` (cloudflared on odroid)
forwards `finbot*.mextner.com` to the origin Caddy on odroid.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Home Server Setup](#home-server-setup)
3. [Public Ingress (Cloudflare Tunnel)](#public-ingress-cloudflare-tunnel)
4. [GitHub Actions Setup](#github-actions-setup)
5. [Automated Deployment](#automated-deployment)
6. [Deploy reliability](#deploy-reliability)
7. [Stage QA (per pull request)](#stage-qa-per-pull-request)
8. [Manual Operations](#manual-operations)
9. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
Telegram ◄── long polling ── bot (pm2: expensesyncbot, bank-sync, expensesyncbot-stage)
                                 │ :3311 prod / :3312 stage
                                 ▼
                         Caddy on odroid (plain HTTP :80, Caddyfile from this repo)
                                 ▲
                                 │ cloudflared (tunnel odroid-home → http://localhost:80, Host preserved)
                                 │
Users ── HTTPS ──► Cloudflare (TLS)
                   finbot.mextner.com, finbot-app.mextner.com,
                   finbot-stage.mextner.com, finbot-stage-app.mextner.com

GitHub push to main ──► Actions: check (ubuntu-latest) ──► deploy (self-hosted runner on odroid)
```

The bot itself only needs outbound internet (Telegram long polling, Google, AI APIs, banks).
The tunnel is required for the OAuth callback, the Mini App and its `/api`.
If it is down, the bot keeps working; only the Mini App and `/connect` OAuth stop.

| Host | Access | Role |
|---|---|---|
| odroidn2 | `ssh root@odroidn2` (Tailscale) | bot, data, Caddy origin, GitHub runner |

---

## Home Server Setup

Paths mirror the old droplet so `ecosystem.config.cjs`, `start.sh` and the cron scripts work unchanged.

### 1. System packages (as root)

```bash
apt-get install -y git jq curl rsync unzip caddy sqlite3 ca-certificates
usermod -s /bin/bash www-data   # runner and pm2 run as www-data
chown www-data:www-data /var/www
```

### 2. Runtime (as www-data, `su - www-data`)

```bash
cd /var/www
mkdir -p .nvm/versions/node
curl -fsSL https://nodejs.org/dist/v22.17.0/node-v22.17.0-linux-arm64.tar.xz | tar -xJ -C .nvm/versions/node
mv .nvm/versions/node/node-v22.17.0-linux-arm64 .nvm/versions/node/v22.17.0
curl -fsSL https://bun.sh/install | bash -s bun-v1.2.17
export PATH=/var/www/.nvm/versions/node/v22.17.0/bin:/var/www/.bun/bin:$PATH
bun add -g pm2
# .bashrc for interactive shells, .profile for `su - www-data -c "pm2 ..."`
for f in ~/.bashrc ~/.profile; do echo 'export PATH=/var/www/.nvm/versions/node/v22.17.0/bin:/var/www/.bun/bin:$PATH' >> "$f"; done
```

`/var/www/.ssh/id_ed25519` is the key `git pull` uses (`origin` is `git@github.com:alex-mextner/ExpenseSyncBot.git`).

### 3. Project

```bash
git clone git@github.com:alex-mextner/ExpenseSyncBot.git /var/www/ExpenseSyncBot
cd /var/www/ExpenseSyncBot
git submodule update --init
mkdir -p data logs
cp .env.example .env && nano .env   # GOOGLE_REDIRECT_URI=https://finbot.mextner.com/callback, MINIAPP_URL=https://finbot-app.mextner.com, OAUTH_SERVER_PORT=3311
bun install
bun install --cwd src/services/bank/ZenPlugins
bunx playwright install chromium     # table renderer (as root: bunx playwright install-deps chromium)
(cd miniapp && bun install --frozen-lockfile && bun run build)
```

Stage bot: `.env.stage` in the repo dir holds overrides (stage `BOT_TOKEN`, port 3312, `./data/expenses-stage.db`);
its working directory is `/var/www/ExpenseSyncBot-stage`. `stage-bot.yml` and `scripts/stage-follow-main.sh`
run `pm2 save` after every successful stage start, so a reboot resurrects the stage bot that is currently
deployed; it restarts with exponential backoff, so missing code cannot crash-loop it hot.

### 4. PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
# as root — registers pm2-www-data.service for boot:
env PATH=$PATH:/var/www/.nvm/versions/node/v22.17.0/bin /var/www/.bun/bin/pm2 startup systemd -u www-data --hp /var/www
```

`ecosystem.config.cjs` pins `TZ=UTC`: cron schedules (exchange rates, monthly tab clone) and date math
have always run in UTC, while the odroid system clock is Europe/Belgrade.
It also sets `NODE_ENV=production` (info-level JSON logs). Bun's `.env` autoload never overrides a
variable already in the process environment, so a `NODE_ENV` line in `.env` has no effect on prod;
the stage bot runs outside the ecosystem file with `--no-env-file --env-file=<merged .env>` and takes
`NODE_ENV` from that file: `production` gives info-level JSON logs; `test` gives silent logs and
an in-memory SQLite database (`DATABASE_PATH` is ignored, data is lost on restart), so never use it
on stage; anything else (use `development`) gives debug-level pino-pretty logs. `LOG_LEVEL`, when
set, overrides the level in every case.

### 5. Caddy (origin)

```bash
ln -sf /var/www/ExpenseSyncBot/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
```

The repo `Caddyfile` uses `http://` site addresses: TLS lives at Cloudflare. Deploys run
`caddy reload --config /etc/caddy/Caddyfile`, so Caddyfile changes ship with the code.

### 6. Cron (as www-data, `crontab -e`)

```cron
0 3 * * * cd /var/www/ExpenseSyncBot && PATH=/var/www/.bun/bin:$PATH ./scripts/backup-db.sh >> logs/backup.log 2>&1
*/2 * * * * /var/www/ExpenseSyncBot/scripts/healthcheck-alert.sh >> /var/www/ExpenseSyncBot/logs/healthcheck.log 2>&1
17 * * * * /var/www/ExpenseSyncBot/scripts/run-log-retention.sh >/dev/null 2>&1
```

The healthcheck probes the public URL (`https://finbot.mextner.com/health`), so it alerts on tunnel or bot failure alike.
A failed probe is retried 3 times, 15 s apart, before alerting, so a deploy's ~10 s PM2 restart doesn't trigger a false alert. Log lines and alert times are UTC.

The hourly `run-log-retention.sh` is the only thing that ever deletes logs (criteria in [Deploy reliability](#deploy-reliability)); it alerts the admin chat over Telegram, so its output is not kept (run it by hand to see every action, add `--dry-run` to change nothing). A run that overlaps a deploy is harmless: the files the deploy just set aside are protected for 5 minutes, and a lost race only makes the deploy's own `gzip` warn.

### 7. LAN address

The odroid gets its LAN address (currently 192.168.0.39) from DHCP without a reservation; it may change.
Nothing depends on it: cloudflared and the GitHub runner dial out; SSH uses Tailscale (`odroidn2`, 100.116.57.66).

### 8. Storage: WD500 HDD, not the SD card

The SD card is the suspected cause of a hang (no logs survived it), so the bot's directories live on the WD500 HDD (`/mnt/wd500`, ext4,
UUID `83c5bd3c-2cfa-494e-b0a5-17d3c92d0925`) and are bind-mounted back to their usual paths:

| Path | HDD source |
|---|---|
| `/var/www/ExpenseSyncBot` (code, `data/`, `logs/`) | `/mnt/wd500/odroid-rt/www/ExpenseSyncBot` |
| `/var/www/ExpenseSyncBot-stage` | `/mnt/wd500/odroid-rt/www/ExpenseSyncBot-stage` |
| `/var/www/actions-runner` (runner + `_work`) | `/mnt/wd500/odroid-rt/www/actions-runner` |

- fstab block `# >>> expensesyncbot-www` (`bind,nofail,x-systemd.requires-mounts-for=/mnt/wd500`),
  next to the host's own `# >>> wd500-runtime` block (docker, containerd, `/home/ultra`).
- `pm2-www-data.service`, the runner service and `caddy.service` have `RequiresMountsFor=` drop-ins
  (`/etc/systemd/system/<unit>.d/10-wd500.conf`): without the HDD they don't start, rather than
  starting on empty SD directories (caddy: `/etc/caddy/Caddyfile` is a symlink to the repo
  `Caddyfile` on the HDD, so without the drop-in it fails at once and is never retried).
- Move script: `/usr/local/sbin/expensesyncbot-move-to-wd500` (final rsync + bind mount, ~16 s downtime;
  it renames the SD originals to `*.sd-old`, which were then deleted — see below).

Check: `findmnt /var/www/ExpenseSyncBot` must show `<wd500 device>[/odroid-rt/www/ExpenseSyncBot]` (the `sdX` letter can change across boots).

**Booted without the HDD** (everything on it stays down by design): reconnect the disk, then

```bash
systemctl start odroid-disk-recover   # starts whatever the boot left down, see below
```

**No SD fallback.** The pre-move SD copies (`/var/www/*.sd-old`) were deleted on 2026-10-10 after
verifying the HDD held everything. The WD500 is the only live copy of the code, `data/` and `logs/`.
The daily DB backups in `data/backups/` sit on the same HDD, so they cover a broken database, not a
dead disk: copy `data/backups/` off the box if the HDD itself becomes suspect. Code can always be
redeployed from GitHub.

#### USB disks at boot: event-driven chain

Rule: a disk problem never blocks or fails boot, and nothing that depends on a disk fails for
good — it waits for the disk, and everything else boots without it.

**Root cause of the 2026-10-16 incident** (prod down ~85 min): the fstab had
`x-systemd.device-timeout=15s` (storage) / `30s` (wd500). The 3 TB Toshiba behind `/mnt/storage`
sits on a JMicron JMS578 UAS bridge whose first READ(16) hangs ~30 s on every boot
(`uas_eh_abort_handler` … `uas_eh_device_reset_handler success` in `dmesg`), and the WD500's
`/dev/disk/by-uuid` device only reached systemd after that hang cleared. That boot systemd started
at 4.3 s, timed out the device jobs at 20.7 s / 35.7 s, both disks appeared at 38.5 s — but the
mounts, binds, containerd, docker, ha-compose, pm2-www-data, the ExpenseSyncBot runner, caddy
(`finbot*.mextner.com` answered 502) and the swapfile had already `dependency-failed`, and systemd
never retries those. The `*/2` healthcheck lives under the `/var/www/ExpenseSyncBot` bind, so it
could not alert either.

**The chain (live on odroid):** disk-dependent units are pulled in by the disk's arrival instead of
by `multi-user.target`, so there is no boot-time deadline to miss:

- `/mnt/wd500` (fstab `noatime,x-systemd.device-timeout=300s,x-systemd.wanted-by=<WD500 .device>`):
  the device appearing starts the mount, whenever that is.
- The six binds (`/var/lib/containerd`, `/var/lib/docker`, `/home/ultra`, `/var/www/ExpenseSyncBot`,
  `/var/www/ExpenseSyncBot-stage`, `/var/www/actions-runner`): `x-systemd.wanted-by=mnt-wd500.mount`
  plus `x-systemd.requires-mounts-for=/mnt/wd500`.
- Services hang off their bind via `/etc/systemd/system/<bind>.mount.wants/` symlinks and are
  **disabled in `multi-user.target`**: `var-www-ExpenseSyncBot.mount` → caddy, pm2-www-data;
  `var-www-actions\x2drunner.mount` → the ExpenseSyncBot runner; `var-lib-containerd.mount` →
  containerd; `var-lib-docker.mount` → docker; `home-ultra.mount` → ha-compose.
- `/mnt/storage` is `nofail,x-systemd.automount`; its swapfile is `noauto` and wanted by the storage
  `.device` (`dev-disk-by\x2duuid-8da3f69e….device.wants/`).

**Safety net:** `odroid-disk-recover.service` (enabled, `WantedBy=multi-user.target`, `Type=exec` so
boot doesn't wait for it) runs `/usr/local/sbin/odroid-disk-recover` once per boot. Sources:
[`scripts/odroid-disk-recover.sh`](scripts/odroid-disk-recover.sh) and
[`scripts/odroid-disk-recover.service`](scripts/odroid-disk-recover.service).

- Waits up to 15 min for each disk's `/dev/disk/by-uuid/<uuid>`, lets the boot transaction finish
  (`systemctl is-system-running --wait`, up to 10 min of its own — a slow boot does not eat
  into the disk wait), then checks every unit of the chain; one the chain
  missed (not active) is `systemctl start`ed (one still starting: it waits for that job's outcome).
  On a normal boot the chain did everything and the run logs `… nothing to do`
  (`journalctl -u odroid-disk-recover -b`).
- A unit it had to start: logged as a warning plus a Telegram note to the admin.
- A disk missing after 15 min or a unit that won't start: logged at err (`journalctl -p err`), sent
  to the admin over Telegram, and the unit ends `failed` (`systemctl --failed`). An alert that
  isn't confirmed by Telegram (`"ok": true`; 3 tries, 30 s apart) is logged at err and fails the
  unit as well.
- The Telegram credentials come from `/opt/hypercal/.env` (`BOT_TOKEN`, `BOT_ADMIN_ID`; same admin
  chat as this bot's `BOT_ADMIN_CHAT_ID`): it sits on the SD card, so the alert still works when
  the WD500 — and with it this bot's `.env` and healthcheck — is missing.

Verify (safe on the live box):

```bash
systemctl list-dependencies mnt-wd500.mount           # 6 binds, each with its services below
systemctl list-dependencies 'var-www-ExpenseSyncBot.mount'   # caddy, pm2-www-data
systemctl --failed                                    # expect nothing
```
Drills:

```bash
odroid-disk-recover --dry-run        # what it would start/send right now; starts nothing
odroid-disk-recover --test-alert     # one test message through the Telegram path
# a disk that never appears, without waiting 15 min (err line + the alert it would send):
systemd-run --wait --unit=odroid-disk-recover-drill -E WD500_UUID=00000000-dead-beef-0000-000000000000 \
  -E WAIT_SEC=20 /usr/local/sbin/odroid-disk-recover --dry-run
journalctl -u odroid-disk-recover-drill -p err; systemctl reset-failed odroid-disk-recover-drill
```

Install or update (as root on odroid, from a checkout):

```bash
install -m 755 scripts/odroid-disk-recover.sh /usr/local/sbin/odroid-disk-recover
install -m 644 scripts/odroid-disk-recover.service /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/odroid-disk-recover.service
systemctl daemon-reload && systemctl enable odroid-disk-recover
```

A disk that appears more than 15 min after boot is still picked up by the chain (the device starts
its units); the guard has already alerted by then.

Open follow-ups: an owner-approved reboot test of the chain; optionally the usb-storage quirk
`152d:0578:u` (disable UAS on the JMS578) to drop the 30 s first-read hang.

---

## Public Ingress (Cloudflare Tunnel)

DNS for `mextner.com` is on Cloudflare. The tunnel `odroid-home` runs as the `cloudflared`
service on odroid (token-based, ingress managed in the Cloudflare dashboard) and routes
these hostnames to `http://localhost:80` with the original Host header:

| Hostname | Caddy site | Serves |
|---|---|---|
| `finbot.mextner.com` | prod bot | landing, `/privacy`, `/terms`, `/callback`, `/health`, `/api` |
| `finbot-app.mextner.com` | prod Mini App | `miniapp/dist`, `/api` |
| `finbot-stage.mextner.com` | stage bot | `/callback`, `/health`, `/api` |
| `finbot-stage-app.mextner.com` | stage Mini App | `miniapp/dist`, `/api` |

Google OAuth redirect URIs (`https://finbot*.mextner.com/callback`) and the BotFather Mini App URL
must match `GOOGLE_REDIRECT_URI` / `MINIAPP_URL` in the prod and stage `.env`.

---

## GitHub Actions Setup

`deploy.yml` and the stage job in `stage-bot.yml` run on a self-hosted runner (labels `self-hosted, odroid`)
installed in `/var/www/actions-runner` as a systemd service running as `www-data`:

```bash
# as root on odroid
cd /var/www/actions-runner
./bin/installdependencies.sh
TOKEN=...   # gh api -X POST repos/alex-mextner/ExpenseSyncBot/actions/runners/registration-token --jq .token
su - www-data -c "cd /var/www/actions-runner && ./config.sh --unattended --url https://github.com/alex-mextner/ExpenseSyncBot --token $TOKEN --name odroid --labels odroid --work _work --replace"
./svc.sh install www-data && ./svc.sh start
```

The repository is public, so `stage-bot.yml` only runs the stage job for PRs whose head branch
lives in this repository, that were not opened by a GitHub App bot (Dependabot, Renovate,
github-actions, …) and whose triggering event did not come from one — except `closed`, which runs
no PR code (it removes the worktree and restarts stage from main). So a bot's push alone never puts
code on the home server; a later human push to the same branch carries the bot's commits along, as
that person's call. An automation that works under a normal user account (a PAT) looks like a
person to that guard: don't give such accounts write access. The guard lives in the
PR's own copy of the workflow: it stops untrusted *code*, not untrusted *workflow edits*. Anyone who
can push a workflow file to this repository can target the runner (e.g. with an `on: push`
workflow), so the trust boundary is write access to `.github/workflows` — keep it to people and to
bots that only bump versions. Fork PRs can edit workflows too: fork-PR workflows must wait for
manual approval for **all** outside contributors, and a fork run is approved only after reading
its workflow changes (approval is the only gate GitHub offers a user-owned public repo; it does not
make the runner safe by itself). Settings → Actions → General → fork pull request workflows, or
`gh api -X PUT repos/alex-mextner/ExpenseSyncBot/actions/permissions/fork-pr-contributor-approval -f approval_policy=all_external_contributors`

Secrets used: `BOT_TOKEN`, `BOT_ADMIN_CHAT_ID` (deploy notifications, runner watchdog).

The one other self-hosted job a pull request can cause is the per-PR stage QA, on its own runner (label `stage-qa`, runner `odroid-esb-qa` of the user `hcb-qa`) and only through the `workflow_run` workflow `Stage QA` from `main`: see "Stage QA (per pull request)".

When a job ends, the runner SIGKILLs every process that still carries the job's
`RUNNER_TRACKING_ID` ("Terminate orphan process" in the job log). Steps therefore run pm2 as
`env -u RUNNER_TRACKING_ID …/pm2`; otherwise pm2 passes the id to the apps it (re)starts and they
are killed seconds after the deploy.

**Runner watchdog** (`runner-watchdog.yml`, every 15 min): queues a no-op `ping` job on the
odroid runner and, from a GitHub-hosted job, checks that it gets picked up within 5 minutes
(a runner busy with a job started in the last 30 minutes counts as online). If not, it alerts the
admin chat once and sends a recovery message when the runner is back; the last announced state is
kept in the Actions cache. Logic: `ci/runner-watchdog/runner-watchdog.sh`.
Manual check: `gh workflow run runner-watchdog.yml`. GitHub disables scheduled workflows in a
public repo after 60 days without repository activity; re-enable with
`gh workflow enable runner-watchdog.yml`.

---

## Automated Deployment

1. Push to `main`
2. `check` job (ubuntu-latest): typecheck, lint, tests, Mini App build
3. `deploy` job (odroid runner) in `/var/www/ExpenseSyncBot`:
   - take the host deploy lock (after `git fetch`), then `git pull origin main`, `git submodule update --init`
   - the host deploy lock (waits for any other deploy on the odroid, see [Deploy reliability](#deploy-reliability))
   - `bun install` (root + ZenPlugins), Mini App build
   - the running release's logs are saved, then the current logs are renamed aside (never deleted), `caddy reload`, pm2-logrotate config
   - `pm2 reload ecosystem.config.cjs --update-env`, the set-aside logs are compressed
   - health verdict (processes online, `/health` ok and stable); on failure the job fails and a failed-release bundle is saved
   - log retention sweep
4. Telegram notification to the admin chat (a failure alert names the evidence directory and the verdict)
5. If the stage bot runs from the main checkout (no PR holds the stage slot), it is restarted on
   the new commit; a stage bot running a PR worktree is left alone (`scripts/stage-follow-main.sh`)

`.env` and `data/` are never touched by the deploy. Migrations run on bot startup.

---

## Deploy reliability

One incident, 2026-10-24: a HyperCalendarBot deploy overlapped an ExpenseSyncBot deploy on the odroid (a 16-minute `docker load` next to this repository's install, build and pm2 reload), the box hit 33-62 % iowait, HyperCalendarBot's fixed health poll ran out and it rolled a healthy release back, and the rollback destroyed that release's logs. This repository's deploy ended at `pm2 reload` with no verification at all and kept nothing about the release it replaced. Everything below mirrors HyperCalendarBot's runbook section of the same name (`docs/reference/deploy-runbook.md` there); what differs is pm2 instead of docker, **no automatic rollback** (a failing verdict fails the job loudly with evidence; a blue/green swap is future work), and the runner being `www-data`: **nothing here needs sudo** and nothing has to be installed by hand except the cron line above.

**Host deploy lock.** `scripts/odroid-deploy-lock.sh` is a byte-identical copy of HyperCalendarBot's (keep the two in step; the repository tag is `esb`). It takes an advisory `flock` on `/run/lock/odroid-deploy.lock` (override: `ODROID_DEPLOY_LOCK_FILE`). `deploy.yml` takes it right after `git fetch origin main`, BEFORE `git pull` / `git submodule update` (so a deploy that waits cannot move the checkout under the one that holds the lock; the script is read from the fetched commit with `git show FETCH_HEAD:`), and before `bun install`; `stage-bot.yml` takes it as the first thing its stage step does, from the **main** checkout's copy, never from PR code. It is held until the step's shell exits, so it covers install, build, reload, verdict and retention. A second deploy, from either repository, WAITS (it logs `deploy-lock: ... held by: <repo> pid=... since=...` every 30 s, `ODROID_DEPLOY_LOCK_SLICE`) for up to 2400 s (`ODROID_DEPLOY_LOCK_MAX_WAIT`), then exits **75**: the job fails with "gave up waiting for the host deploy lock" and can simply be re-run. It never breaks a live holder, and the kernel drops the lock when the holder dies, so a crashed or cancelled deploy cannot wedge the host. `<lock>.owner` (repo, pid, process start ticks, start time) is informational and judged stale by pid + start ticks. The lock file is created mode 0666 so `www-data` (this repository) and root (HyperCalendarBot) can both open it. Both jobs have `timeout-minutes: 100` (GitHub's default would be 360): 40 min of waiting, up to 15 min of verdict and room for installs. pm2 runs with the lock's file descriptor closed: a pm2 daemon started from a deploy step would otherwise inherit it and keep the lock after the step ended. A checkout that does not have the script yet (before the first prod deploy that ships it) runs the *stage* step unlocked with a `::warning::`; the prod deploy step has no such fallback. Check by hand: `flock -n /run/lock/odroid-deploy.lock true && echo free || cat /run/lock/odroid-deploy.lock.owner`. Not covered: the short `stage-follow-main.sh` step after a prod deploy, cron jobs and manual `pm2` work.

**Evidence before anything is replaced.** `scripts/deploy-evidence.py` (python3, which the runner needs; HyperCalendarBot's runner needs it on the same host) runs under `timeout 300` and bounds every pm2/host command to 30 s, so it cannot hold a reload up for more than 5 minutes. Its directories are mode 0700 and its files 0600, in `/var/www/ExpenseSyncBot/logs/`:

- `release-<sha12 of the outgoing checkout>-<UTC stamp>/`, saved before the current logs are set aside and before `pm2 reload`: `expensesyncbot.out.log.gz`, `expensesyncbot.err.log.gz`, `bank-sync.out.log.gz`, … (the last 16 MB of each app's current log, raw, from the paths pm2 itself reports) and `processes.json` (an allow-list of pm2 fields: status, restart counts, uptime, memory, log paths; **never** the apps' environment, which holds every production secret). The live files are only read.
- `failed-<sha12 of the deployed commit>-<UTC stamp>/`, saved when anything fails after the reload was issued (the reload itself or the verdict), before anything else restarts: `state.txt` (per app: status, restart count, uptime, memory, level >= 50 lines in the tail), `processes.json`, `<app>.<out|err>.tail.redacted.log` (last 400 lines, at most 256 KiB), `verdict.log` (the health script's output), `host-load.txt` (`/proc/loadavg`, PSI, `free -m`, `uptime`, `df -h`, `vmstat`) and `logs-index.txt` (names, sizes and times in `logs/`). The job log prints `FAILED_EVIDENCE <dir>`, and the failure alert in Telegram carries the directory and the verdict line.
- Redaction (tail and verdict files): Telegram bot tokens, JWTs, API keys (`sk-…`, `ghp_…`, …), Google OAuth tokens (`ya29.…`) and API keys (`AIza…`), `Bearer` values, `password` / `secret` / `token` / `api_key` / `encryption_key` / `authorization` / `cookie` assignments, credentials in URLs, and the value of the JSON fields `text`, `caption`, `prompt`, `content`, `query`, `transcript`, `body`, `message_text`, `question`, `answer`, `description`, `merchant`, `comment`, `input`, `reply` (when such a field holds an array or an object, the rest of that log line goes), and the `msg` of the `[MSG]` (incoming chat message), `[VALIDATOR]` and `[ADVICE-VALIDATOR]` log lines. The `release-*` copies are raw (they are the never-delete copy of what the logs already hold) and stay private.
- Read them as `www-data`: `ls -lt /var/www/ExpenseSyncBot/logs/ | head`, `cat logs/failed-*/state.txt` (a day after a failure the hourly retention gzips the small members too: then `zcat logs/failed-*/state.txt.gz`), `zcat logs/release-*/expensesyncbot.out.log.gz | less`. Clean up only with `scripts/run-log-retention.sh`; do not `rm` evidence by hand while a failure is being investigated.

**Health verdict.** After the reload `scripts/deploy-health.py wait` decides. A slow start is not a failure; a dead or crash-looping app is. It accepts the release when `expensesyncbot` and `bank-sync` are in pm2's list and `online` (not `errored`, `stopped` or `waiting restart`), their restart counts have not climbed by 2 since the reload, `/health` (`http://127.0.0.1:<OAUTH_SERVER_PORT from .env, default 3000; prod 3311>/health`, answers `{"status":"ok"}`) stays ok and the apps stay online for **30 s** (one restart only restarts that window). At the end of the window, log lines written since each app (re)started (older lines never count) fail it on any pino fatal (level >= 60) and on more than 20 lines at level >= 50; fewer are only reported. The budget is **240 s**; past it the wait continues only while the host is saturated (PSI `io` avg10 >= 20 or load1 > 1.5 x cores) AND the apps are alive AND their logs or states changed within 120 s, never past a hard cap of **900 s**. An errored, missing or crash-looping app is `dead` at once, with no waiting; pm2 not answering 3 polls in a row is `dead` too. Output ends with `RESULT verdict=<ok|dead|unhealthy> health=… apps=name:status:restarts,… elapsed=… reason=…`; exit 0 ok, 3 dead, 4 unhealthy. A failing verdict fails the job (`notify-failure` sends it with the evidence directory) and the new release stays up for inspection: **there is no rollback**, so fix forward or revert `main`. Knobs, set in the step's environment (`DEPLOY_HEALTH_POLL` 4, `DEPLOY_HEALTH_STABLE` 30, `DEPLOY_HEALTH_BASE_BUDGET` 240, `DEPLOY_HEALTH_HARD_CAP` 900, `DEPLOY_HEALTH_MAX_ERROR_LOGS` 20); the script's own flags have the same names (`--stable`, `--base-budget`, …).

**Log retention (nothing is deleted by a deploy or a failure).** The deploy step renames `error.log`, `out.log` and `healthcheck.log` aside as `<name>_<stamp>.log` right before the reload (`mv -n`, which never overwrites) and compresses them **after** the reload: the old process keeps writing into the file it holds open until it stops, and compressing earlier would unlink that file under it and lose those lines. `pm2-logrotate` is configured `max_size 20M`, `compress true`, `dateFormat YYYY-MM-DD_HH-mm-ss` and **`retain 100000`** (it deletes the oldest rotated files beyond `retain`, and its README documents only numbers, so this is a count no logs directory reaches; the earlier `retain 14` silently deleted every rotation past the 14th), so pm2 deletes nothing either. The only deleter is `scripts/run-log-retention.sh`, which runs `scripts/log-retention.py` (a byte-identical copy of HyperCalendarBot's; keep the two in step) after every verified deploy (it cannot fail the deploy) and hourly from cron. It manages only rotated files, never the current ones pm2 holds open (`out.log`, `error.log`, `bank-sync-*.log`): `--only-glob` names `*__*.log[.gz]` (pm2-logrotate) and `*_<stamp>.log[.gz]` (the deploy step), plus the `release-*` / `failed-*` directories; `logs/chats/`, `healthcheck.log`, `backup.log` and everything else are untouched and not counted. It first gzips old plain rotated files, then deletes oldest-first, one entry at a time, only while a criterion is violated: managed bytes > **1024 MB**, managed entries > **400**, any file > **200 MB**, or free space on the filesystem < **2048 MB / 5 %**. It never deletes the newest `release-*` (last deploy), the newest `failed-*` (last failure) or anything modified in the last 5 minutes; when only those are left and a criterion is still violated it stops with exit 2 (the wrapper passes the exit status on). Any deletion, free space below the floor (and an early warning at twice the floor) and an unresolved violation send a Telegram message to the admin chat, at most once per kind per 6 hours (state in `logs/.log-retention-state.json`). The script reads `BOT_TOKEN` and `BOT_ADMIN_ID` from an env file; this repository's admin chat is `BOT_ADMIN_CHAT_ID`, so the wrapper hands it a private temporary env file with that value under the name it reads (`.env` itself is only read). To preview: `scripts/run-log-retention.sh --dry-run`; to tighten for a test: `--max-dir-mb 512`.

**Failure drills and troubleshooting.** `exit 75` in a deploy job: another deploy held the lock for 40 minutes; look at the `deploy-lock: ... held by:` lines, re-run when it is done. `verdict=dead` / `unhealthy`: open the evidence directory from the alert, read `state.txt` and the redacted tails, then `pm2 describe expensesyncbot` (its environment section holds secrets: do not paste it). Disk below the floor with only protected entries left: free space by hand (outside `logs/release-*` / `failed-*` of the last deploy and failure), then re-run the sweep.

---

## Stage QA (per pull request)

Every same-repository PR gets a QA run that drives the stage bot, [@ExpenseSyncStageBot](https://t.me/ExpenseSyncStageBot), with real Telegram messages through qa-cli, and the result is the commit status `stage-qa` on the head SHA (ticket [#214](https://github.com/alex-mextner/ExpenseSyncBot/issues/214); HyperCalendarBot has the same check, [HCB #840](https://github.com/alex-mextner/HyperCalendarBot/issues/840), and shares the browser host, its Telegram session and its lock). `gh ship` (`.claude/scripts/pr-ship.sh`) refuses to merge unless `stage-qa` is green for the exact head; after the merge `deploy.yml` deploys as before. Nothing of the QA sits inside the production deploy. There is no Telethon session and no 2FA: the QA account is the Telegram Web login qa-cli holds on the browser host (`qa telegram status`). The `qa` job runs on the odroid (production host, where the stage slot is); the browser runs on the server 65.21.40.51 because the odroid has no memory to spare for it (see "Why the browser runs on the server").

**The stage slot is shared, so the QA does not own the bot.** `stage-bot.yml` (unchanged) deploys the head of whichever PR changed last to ONE pm2 slot (`expensesyncbot-stage`, `/var/www/ExpenseSyncBot-stage`, worktree `/var/www/ExpenseSyncBot/.claude/worktrees/<branch>`). The QA therefore (a) queues for the shared browser lock first (nothing is asked of the odroid meanwhile), (b) waits until the slot runs exactly the PR head, (c) runs the cases, (d) asks again afterwards: if the slot moved to another PR, or was redeployed, the result is void (no status, exit 76); if pm2 restarted the bot by itself the run failed. A PR whose slot is taken before its QA ran, or that never got it, has no `stage-qa` status or an `error`: **re-run the `Stage Bot` workflow of that PR** (it redeploys the head and `Stage QA` follows).

**Pipeline.**
1. `Stage Bot` (`pull_request`) deploys the head to the slot, as before.
2. `.github/workflows/stage-qa.yml` (`Stage QA`, `workflow_run` of `Stage Bot`) always runs the copy on `main`; it checks nothing out and downloads no artifact. Job `eligible` (hosted) lets through only an OPEN same-repository PR, not opened by a bot, whose head is exactly this commit (forks, bot PRs and the `closed` event deploy nothing, so the driver would wait for a commit the slot never runs while holding the QA runner). Job `qa` ("Stage QA run") runs on the odroid's own runner labelled `stage-qa` (`odroid-esb-qa`, see Install) and does one thing: `python3 /usr/local/lib/esb-stage-qa/stage-qa-driver.py "$HEAD_SHA"`; it has no token. Job `report` (hosted, the only job with `statuses: write`) posts `stage-qa`: `success` as `passed cases=<n> run=<qa run id>`, `failure` for a failed case, a bot that restarted during the run, or a failed `Stage Bot` workflow, `error` when the QA could not run (refused, not provisioned, lock wait timed out, no result, the slot never ran the commit), and nothing for a superseded or cancelled run.
3. The driver (`scripts/stage-qa-driver.py`, installed root-owned by `install-stage-qa.sh` at `/usr/local/lib/esb-stage-qa/`, config `/etc/esb-stage-qa/driver.json`) asks the report script through `sudo -n /usr/local/lib/esb-stage-qa/odroid-stage-qa-report.py` (the runner user's only sudo right) until the slot runs the head and the bot is online (`slot_wait`, default 10 min, one question every `slot_poll` = 20 s). The order is the point: the driver opens the ssh connection to the browser host FIRST (the commit as the command line, stdin kept open, with a key whose `authorized_keys` entry is `restrict,command="/home/ultra/esb-stage-qa/bin/stage-qa-browser"`: the only thing that key can do there is run the ESB browser half with a commit SHA) and waits for the browser half's single stdout line `STAGE_BROWSER_LOCKED` (`lock_timeout`, default 50 min, no line in time is exit 3; if the browser half ends first its exit status is the verdict). Only then does it ask the report script (sudo, below) until the slot runs the head and the bot is online (`slot_wait`, default 10 min, one question every `slot_poll` = 20 s) and hand that report line to the browser half as the first stdin line (`browser_timeout`, default 30 min, bounds the cases). A queued run therefore waits for the other repository's run without having touched the stage slot, and a run whose odroid side ends early (slot never ran, refused, cancelled) closes the connection's stdin so the browser half exits and frees the lock.
4. `scripts/odroid-stage-qa-report.py` (read-only, root-owned, run as root through `sudo -n` with no argument) answers ONE line `STAGE_REPORT {json}`: the commit the slot runs (`git rev-parse HEAD` of the pm2 process's code directory, which must be the main checkout or a git worktree below `.claude/worktrees/`), pm2 `online`, start time and restart counter, the stage username and numeric bot id (proven against Telegram's `getMe`: the stage token must not be the production token and must belong to `ExpenseSyncStageBot`), and the PR's own `scripts/stage-smoke-cases.json` read from that commit with `git show <sha>:` and validated by the engine and `stage_qa_common.case_problem`. It takes no input (sudo resets the environment and the sudoers rule allows no argument), drops from root to `www-data` before it reads anything, runs only `pm2 jlist` (and only when the pm2 daemon is up: asking a stopped one would spawn it), and never writes, starts, stops or locks anything.
5. The browser half (`scripts/stage-qa-browser.py`, the forced command of that key, user `ultra` on the server) takes the browser lock FIRST (`~/.local/state/hypercal-stage-qa/qa.lock`: the HyperCalendarBot half uses the same file, one Telegram Web session at a time), prints `STAGE_BROWSER_LOCKED` and then waits at most `payload_wait` (default 7500 s: the driver's slot wait happens in between) for the report on the first stdin line (EOF or no report in time is exit 1 and the lock is freed). It then validates the report against its own config (the commit asked for, stage username and deny list, bot online with a numeric id, the case floor, required scenarios, the error patterns every case must forbid: the report is data, not trusted), runs the cases with `stage-smoke.py run` (`qa telegram chat send|wait|read` against the stage bot's numeric id; replies are read from the web UI, so blockquote text is readable) and writes the receipt `~/.local/state/esb-stage-qa/receipts/<sha>.json` (case names, counts and latencies only). It prints the last line `STAGE_QA_RESULT status=… sha=… cases=… failed=…`; its exit status is the verdict. When the driver's connection drops (stdin EOF) it stops the cases and frees the lock. The driver checks that the result line names the requested commit (another commit is exit 3) and takes `cases >= 1` for a pass; the floor of cases is the browser half's alone. The driver then asks `report` once more: another commit, an emptied slot or a new start time without a counter increase means a newer PR took the slot (exit 76, void); a raised restart counter or an offline bot is exit 1; otherwise the browser half's verdict stands and the driver prints its own `STAGE_QA_RESULT` line.
6. Exit codes: 0 passed; 1 a case failed, the bot restarted or went offline, or the engine timed out; 2 refused (invalid report or case list); 3 not runnable (config, key, sudoers, qa-cli not logged in, the browser host unreachable, no `STAGE_BROWSER_LOCKED` within `lock_timeout`, a result line for another commit, or its connection ended without a verdict, the report script unable to prove the stage identity); 75 the browser host's lock wait timed out (re-run the workflow); 76 superseded; 77 the slot never ran the commit within `slot_wait`.

**Cases.** `scripts/stage-smoke-cases.json` is the PR's own list (a PR may add cases for the behaviour it changes). The browser half and the odroid script both enforce a floor the PR cannot go below (the case rules live once, in `scripts/stage_qa_common.py`): at least 5 cases and the names `start`, `ping`, `help-lists-commands`, `categories-read-only-listing`, `validation-connect-rejected-outside-group`, `simple-intent-phrase`, `expense-phrase-redirect`. `expect`/`forbid` are regexes over the reply text, `max_first_reply_s` bounds latency, and every case forbids the bot's error texts (`Произошла ошибка`, `непредвиденная ошибка`, `AI-сервис временно недоступен`, …). qa-cli talks to the bot in a direct chat only (`qa telegram chat` refuses anything that is not a bot chat) and the bot works only in groups, so every case exercises the real command router, the middleware and the guards through the bot's direct-chat answers: `/start` (private redirect), `/ping` (pong), `/help` (feature guide), `/categories` (read-only listing: the group guard), `/connect` (validation failure: rejected outside a group), an @mention phrase (AI entry guard) and an expense phrase (redirect; nothing is written because there is no group). **What this does not cover:** commands inside a configured group (stats, sums, sync, the AI answer itself): that needs a group chat in qa-cli. `scripts/stage-smoke.py` is a byte-identical copy of HyperCalendarBot's (keep the two in step; its `guard` and `run` are the shared engine).

**Guards.** Odroid side: the username is fixed in the report script (`ExpenseSyncStageBot`), differs from `ExpenseSyncBot` and the production env's `BOT_USERNAME`, contains `stage`, its token's bot id differs from the production token's, and `getMe` for that token answers with that username. Browser-host side: the report must be for the commit asked for, name the username in that host's own config (`ExpenseSyncStageBot`), which must not be on its deny list (`ExpenseSyncBot`) and must contain `stage`/`stg`; the case list must meet the floor again (the report is data, not trusted); an empty or shorter list is refused, never passed.

**Trust boundary (public repository).** A PR's code already runs on the odroid runner through `Stage Bot` (see "GitHub Actions Setup"; that guard is unchanged). The QA adds one thing that PR code can influence: the case list, which is data (validated by the odroid script and again by the browser half, whose floor does not depend on the odroid, texts passed to qa-cli as one argv element, never through a shell). It never runs as a process on the QA runner, the odroid host or the browser host: `stage-qa.yml` checks nothing out and downloads nothing, its YAML always comes from `main`, the driver, the browser half, the engine and the report script come from a reviewed `main` checkout (`scripts/install-stage-qa*.sh` refuse anything not committed on `origin/main`; on the odroid the installed files are root-owned), and `src/tooling/stage-qa-workflows.test.ts` pins that (no other workflow may use the `stage-qa` runner label). The runner user can run nothing as root except the read-only report script (sudoers, no arguments) and nothing on the browser host except one forced command that accepts a commit SHA and a report line; no GitHub token is involved. Residual risk: PR code running in the stage slot can answer the QA's messages however it likes (it IS the bot under test), and a collaborator with write access could change what `stage-bot.yml` deploys; both are the existing trust boundary (write access to this repository). A PR can also weaken its own `expect` patterns within the floor; reviewers read the diff of `scripts/stage-smoke-cases.json`.

**Why the browser runs on the server and the job on the odroid (decided with numbers, tg#25322, shared with HyperCalendarBot).** The browser half needs Telegram Web in a headless Chromium logged in with the qa-cli account. Measured 2026-10-28:

| | odroid (aarch64, 3.7 GB, runs production) | server 65.21.40.51 (x86_64, 31 GB) |
|---|---|---|
| memory the box has to spare | 678 to 1466 MB available over a day of samples (free 83 to 281 MB), swap 2.5 GB in use, memory pressure `some` avg300 3 to 10 %, `full` avg60 up to 37 % | 7.5 to 8.6 GB available |
| Chromium on Telegram Web | 391 to 586 MB cgroup peak just to reach the logged-in chat list, more with a chat open: not run there, it would push the live bots into swap | cgroup peak 391 MB (Playwright Chromium) and 586 MB (agent-browser's Chrome 156) for `qa telegram status`; 996 MB with the `status` session and a `chat` session open at the same time; a stage run uses the chat session only |
| reach | the odroid can open tcp 22 to the server | the server cannot reach the odroid (no tailscale, NAT), so the call direction is odroid to server |

The session (`~/.agent-browser/sessions/qa-telegram-qa-telegram.json`, cookies plus localStorage) was copied to the server with mode 0600. Sequential use from two addresses does not end the login; concurrent use is what Telegram punishes (an auth key used by two live browsers at once is revoked), hence the one browser lock for both repositories. If the server is down or unreachable the `qa` job ends `not provisioned` (exit 3) and `gh ship` refuses: it fails closed.

**Ship gate.** `scripts/stage-qa-gate.py` (run by `.claude/scripts/pr-ship.sh` from `origin/main`'s copy, never the PR checkout's) requires, for the exact current head of an open, non-draft, same-repository PR: the newest `stage-qa` status is `success`, posted by `github-actions[bot]`, with description `passed cases=<n> run=<id>` and `target_url` the run; that run is a completed, successful `workflow_run` of `.github/workflows/stage-qa.yml` of this repository, from the default branch. A `workflow_run` run reports the default-branch commit as its `head_sha` (its `pull_requests` are empty), so the run object cannot say which PR head was tested; the gate reads that from the job logs, which a PR cannot write. The run must have exactly one successful `Stage QA run` job (steps `Set up job`, then `Run the stage QA through qa-cli`) whose first step header, written by the runner before the trusted shell runs, carries ONE `HEAD_SHA` equal to the PR head, and exactly one successful `Post stage-qa` job whose step `Post the stage-qa status` header carries the inputs of the verdict (`HEAD_SHA`, `RUN_ID`, `BOT_CONCLUSION`, `QA_RESULT`, `QA_RC`, `QA_CASES`), each once, saying that this run passed this head with exactly the case count the status reports; a status forged inside the report job's time window by another workflow cannot change that header. The status must also have been created while that report job ran, and the PR head must not have moved while the gate read. Only the first 256 KiB of each log are read, in memory, and error texts never echo log lines. So: do not rename the jobs, the steps or those env names of `stage-qa.yml` without changing the gate (`stage-qa-gate-binding.test.ts` pins both). It needs a `gh` that knows `--allow-escape-sequences` and exits 2 on any `gh` error or an unreadable or unrecognised log (never a silent pass); exit 1 means not green. It is inactive (and says so) only while `stage-qa.yml` is not on the default branch. A dry run skips it. The repository owner can still merge by hand with `gh pr merge --squash --match-head-commit <sha>`; the gate has no bypass.

**Shared with HyperCalendarBot (one browser, one account, two stage instances).** Both repositories' QA runs drive the same Telegram Web login, so they take ONE lock: `~/.local/state/hypercal-stage-qa/qa.lock` on the browser host (the `lock_file` default of both browser halves and `LOCK_FILE` of both installers; an `flock`, so only one stage QA run of either repository drives qa-cli at a time; `qa.lock.owner` names the holder as `repo=esb-stage-qa-browser` or `repo=hcb-stage-qa-browser`). The ESB driver waits for it at most `lock_timeout` = 3000 s (the browser half itself gives up after `lock_max_wait` = 2700 s). A HyperCalendarBot run holds that lock for its whole life, including its own stage lock and host deploy lock waits (its driver allows up to 5700 s for them), so a slow HyperCalendarBot run can outlast the wait: the ESB run then ends `lock wait timed out` (exit 75, status `error`): re-run `Stage QA`. The stage lock (`/run/lock/hypercal-stage.lock`) and the stage container are HyperCalendarBot's alone: the ESB path takes neither (it only reads), because its stage bot is not started by the QA but is the pm2 slot `expensesyncbot-stage` that `Stage Bot` deploys under the host deploy lock (`/run/lock/odroid-deploy.lock`, shared with every deploy of both repositories). The two stage instances do not clash on ports or names: ESB's stage bot listens on `:3312` (pm2, behind Caddy), HyperCalendarBot's stage container `hypercal-bot-stage` publishes `127.0.0.1:3002`; the bots, tokens and usernames differ (`ExpenseSyncStageBot` here), and each browser half refuses the other repository's bot (its deny list names the production bot of its own repository, and the report must name the `username` of its own config). The runner user `hcb-qa`, the host key in its `known_hosts` and the browser host account `ultra` are shared; the runner service, `_work` directory, ssh key, sudoers file, forced command, `lib/`, `bin/` and config are separate, so installing or rolling back one repository never touches the other's files. The browser toolchain (`~/hypercal-stage-qa`: agent-browser, its Chrome, qa-cli, `chrome-libs`, `fonts.conf`, `tmp/`) is one copy for both: whichever installer runs first creates it, the other uses it.

**Install on the odroid (root, by hand, from the merged `main`; the previous files are kept and the rollback is printed).** Nothing here comes from a PR: the installers refuse code that is not committed on `origin/main`. All commands are for the odroid as root (`ssh root@odroidn2`), except where `sudo -u hcb-qa` is shown.
1. *The files.* The deploy of the merge has put the merged `main` into `/var/www/ExpenseSyncBot`; fetch as the checkout's owner so `.git` stays `www-data`'s, check the commit, install:
```bash
sudo -u www-data git -C /var/www/ExpenseSyncBot fetch origin
git -c safe.directory=/var/www/ExpenseSyncBot -C /var/www/ExpenseSyncBot log -1 --oneline origin/main   # the merged commit?
cd /var/www/ExpenseSyncBot && scripts/install-stage-qa.sh
```
   It copies `odroid-stage-qa-report.py`, `stage-smoke.py`, `stage-qa-driver.py` and `stage_qa_common.py` into a fresh `/usr/local/lib/esb-stage-qa` (root:root 0755, swapped in with one rename), creates `/etc/esb-stage-qa/driver.json` (browser host `ultra@65.21.40.51`, the key `/var/lib/hcb-qa-runner/.ssh/esb-stage-browser_ed25519`, that user's `known_hosts`) only if absent and never overwrites it, keeps the previous lib as `/usr/local/lib/esb-stage-qa.bak-<UTC stamp>` (the backup) and prints the sudoers line, the check below and `rollback: …`, the one command that restores the previous lib (or, on a first install, removes the lib and the config it created); a failed install removes the config it just created. Copy the `rollback:` line somewhere before going on. It touches only its own lib and config: no pm2, no checkout, no env file, no sudoers file, no log. Re-run it after every change to the installed files (merging such a change does not update the odroid).
2. *Sudoers (once).* Same pattern as `/etc/sudoers.d/hcb-qa` (`hcb-qa ALL=(root) NOPASSWD: /usr/local/sbin/hypercal-stage-qa`) in a file of its own, so neither repository's edit touches the other's: `visudo -f /etc/sudoers.d/esb-stage-qa` (creates it 0440), one line, the one the installer prints:
```
hcb-qa ALL=(root) NOPASSWD: /usr/local/lib/esb-stage-qa/odroid-stage-qa-report.py ""
```
   The `""` is part of the rule: the runner user can run exactly that file with no arguments, nothing else as root (the report script only reads; it is the only thing the ESB QA ever runs as root). Check: `sudo -u hcb-qa sudo -n /usr/local/lib/esb-stage-qa/odroid-stage-qa-report.py` prints one `STAGE_REPORT {…}` line (`username` `ExpenseSyncStageBot`, `sha` the commit of the stage slot, `online`). Rollback: `rm /etc/sudoers.d/esb-stage-qa`.
3. *Key to the browser host (once).* A second key, not the HyperCalendarBot one, so each `authorized_keys` entry on the server is forced to its own repository's command: `sudo -u hcb-qa ssh-keygen -t ed25519 -N '' -C esb-stage-qa-odroid -f /var/lib/hcb-qa-runner/.ssh/esb-stage-browser_ed25519`. `known_hosts` of that user already holds the server's ed25519 host key (`SHA256:r6rzuSavC6UP1j4chS8J/3fkVAJjZGQE1BzeyLfBKgg`, from `ssh-keyscan -t ed25519 65.21.40.51`; compare the fingerprint before trusting a new one). Print the public half for the browser-host step: `sudo -u hcb-qa ssh-keygen -y -f /var/lib/hcb-qa-runner/.ssh/esb-stage-browser_ed25519`.
4. *The runner (once).* A second Actions runner of the user `hcb-qa` (home `/var/lib/hcb-qa-runner`; the HyperCalendarBot one is `odroid-hcb-qa` in `actions-runner/`), in its own directory `actions-runner-esb/`, registered for THIS repository with the label `stage-qa` (besides the default `self-hosted`, `Linux`, `ARM64`), name `odroid-esb-qa`, as its own service. The registration token comes from a session with admin rights on the repository (`gh` of the owner), not from the odroid:
```bash
# the owner, anywhere: one-hour registration token (do not paste it anywhere else)
gh api -X POST repos/alex-mextner/ExpenseSyncBot/actions/runners/registration-token --jq .token

# root on the odroid: the same runner release as the HyperCalendarBot QA runner, unpacked into its own directory
V="$(/var/lib/hcb-qa-runner/actions-runner/bin/Runner.Listener --version)"
sudo -u hcb-qa -H bash -c "mkdir -p /var/lib/hcb-qa-runner/actions-runner-esb && cd /var/lib/hcb-qa-runner/actions-runner-esb \
  && curl -fsSL -o runner.tgz https://github.com/actions/runner/releases/download/v$V/actions-runner-linux-arm64-$V.tar.gz \
  && tar xzf runner.tgz && rm runner.tgz"
read -rs -p 'registration token: ' TOKEN; echo
sudo -u hcb-qa -H bash -c "cd /var/lib/hcb-qa-runner/actions-runner-esb && ./config.sh --unattended --url https://github.com/alex-mextner/ExpenseSyncBot --token '$TOKEN' --name odroid-esb-qa --labels stage-qa --work _work"
unset TOKEN
cd /var/lib/hcb-qa-runner/actions-runner-esb && ./svc.sh install hcb-qa && ./svc.sh start
# the same resource limits as every other runner service on this host:
S=actions.runner.alex-mextner-ExpenseSyncBot.odroid-esb-qa.service
install -d /etc/systemd/system/$S.d
cat >/etc/systemd/system/$S.d/50-yield-to-services.conf <<'EOF'
[Service]
CPUWeight=20
IOWeight=20
MemoryHigh=1200M
EOF
systemctl daemon-reload && systemctl restart $S && systemctl is-active $S
```
   Check from anywhere with admin rights: `gh api repos/alex-mextner/ExpenseSyncBot/actions/runners --jq '.runners[] | [.name, .status, ([.labels[].name] | join(","))] | @tsv'` lists `odroid-esb-qa  online  self-hosted,Linux,ARM64,stage-qa` next to the deploying runner `odroid` (`self-hosted,Linux,ARM64,odroid`). It is separate from the runner that deploys, so a queue of stage runs never delays a deploy, and the stage key lives with a user that has no deploy rights. Only `stage-qa.yml` targets the label `stage-qa` and every other job is GitHub-hosted or `[self-hosted, odroid]` (`stage-qa-workflows.test.ts`; `.github/actionlint.yaml` lists exactly those two labels): the runners share the default labels, so a job that names only `self-hosted` could land on either. Rollback of the runner: `cd /var/lib/hcb-qa-runner/actions-runner-esb && ./svc.sh stop && ./svc.sh uninstall`, then `sudo -u hcb-qa ./config.sh remove --token <removal token>` (`POST …/actions/runners/remove-token`).

**Install on the browser host (the server 65.21.40.51; the normal user `ultra`, never root; from a checkout of merged `main`).**
```bash
ssh ultra@65.21.40.51
git clone https://github.com/alex-mextner/ExpenseSyncBot.git ~/ExpenseSyncBot-install   # first time; later: git -C ~/ExpenseSyncBot-install pull --ff-only
cd ~/ExpenseSyncBot-install && git log -1 --oneline                                      # the merged commit?
scripts/install-stage-qa-browser.sh
```
It waits up to 60 s for the shared browser lock (a stage run of either repository holds it: it then changes nothing and exits 75), copies `stage-qa-browser.py`, `stage_qa_common.py` and `stage-smoke.py` into `~/esb-stage-qa/lib` and writes the forced-command entry `~/esb-stage-qa/bin/stage-qa-browser` while holding that lock, creates `~/.config/esb-stage-qa/browser.json` (0600; review it, it is never overwritten) only if absent, keeps the previous lib and entry as `.bak-<UTC stamp>` (the backup) and prints the `authorized_keys` line and `rollback: …`. The ESB half has its own `lib/`, `bin/` and config, so the HyperCalendarBot half in `~/hypercal-stage-qa/{lib,bin}` and this one never overwrite each other. The toolchain is SHARED with it and lives in `~/hypercal-stage-qa` (`agent-browser` 0.39.1 and its Chrome, qa-cli at commit `875b11a`, the shared libraries and a font Chrome needs in `chrome-libs`, `fonts.conf`, `tmp/`): the installer uses what is there and installs only what is missing, with the same pins, without root (the newest Chrome by version is the one it checks). The forced-command entry gives Chrome its own `TMPDIR` (`~/hypercal-stage-qa/tmp`): the server's `/tmp` is a tmpfs that other jobs fill. qa-cli must be logged in on the server (`qa telegram status` prints `logged-in`). Nothing else may run `qa telegram chat` with this account while a stage run is in progress (agents on other machines must wait or use their own account): the browser lock covers only stage runs.

Then authorize the odroid key, with a backup first and the public key from step 3 above:
```bash
cp -p ~/.ssh/authorized_keys ~/.ssh/authorized_keys.bak-$(date -u +%Y%m%dT%H%M%SZ)
echo 'restrict,command="/home/ultra/esb-stage-qa/bin/stage-qa-browser" ssh-ed25519 AAAA… esb-stage-qa-odroid' >> ~/.ssh/authorized_keys   # the real public key
```
Rollback of the key: restore that backup (or delete the `esb-stage-qa-odroid` line). Check from the odroid, which proves the key and the forced command without taking the browser lock (a commit that is not 40 hex digits is refused first): `sudo -u hcb-qa ssh -i /var/lib/hcb-qa-runner/.ssh/esb-stage-browser_ed25519 -o BatchMode=yes -o IdentitiesOnly=yes ultra@65.21.40.51 not-a-sha` prints `STAGE_QA_RESULT status=refused sha=- cases=0 failed=0` and exits 2.

**Rollout order.** The gate and the workflow arrive together with the merge, the installs cannot come earlier (the installers accept only merged `main`), so ship in this order and expect a short window in which other PRs have no `stage-qa`:
1. Merge this change. Its own ship passes the gate because `stage-qa.yml` is not yet on `main` ("bootstrap": the gate says `NOT enforced` and ships); `deploy.yml` deploys it as usual.
2. Odroid steps 1 to 4 above (files, sudoers, key, runner); browser host install and `authorized_keys`; the two checks (the `STAGE_REPORT` line, the `refused` line) and the runner listing.
3. Re-run `Stage Bot` of an open PR: `Stage QA` then posts `stage-qa` on its head. Until step 2 is complete a PR's `stage-qa` is missing or `error` (`not provisioned`, or no `qa` runner online: the `qa` job stays queued) and `gh ship` refuses: it fails closed, so do step 2 right after the deploy of the merge. If the install has to be abandoned, revert the merge (the gate becomes inactive again) or merge by hand as the owner (`gh pr merge --squash --match-head-commit <sha>`).
4. Removing it again, in this order: revert the workflow and the gate on `main`, stop and unregister the runner, remove the sudoers file, remove the authorized_keys line, then the printed odroid and browser-host `rollback:` lines.

**Installed (2026-10-29, from merged `main` 1803d1e, #214).** Odroid: `/usr/local/lib/esb-stage-qa`, `/etc/esb-stage-qa/driver.json`, `/etc/sudoers.d/esb-stage-qa`, key `esb-stage-browser_ed25519` of the user `hcb-qa`, runner `odroid-esb-qa` (label `stage-qa`, service `actions.runner.alex-mextner-ExpenseSyncBot.odroid-esb-qa.service`, the `50-yield-to-services.conf` drop-in). Browser host: `~/esb-stage-qa/{lib,bin}`, `~/.config/esb-stage-qa/browser.json`, one `authorized_keys` line (backup `authorized_keys.bak-esb-stage-qa-20261029`). Checked: the `STAGE_REPORT` line as `hcb-qa`, and the `refused` line over ssh for a non-SHA argument.

**Logs are never deleted by this path.** The odroid script only reads (a test snapshots every file under the checkouts, the env files and pm2 home before and after a run); the installers touch only their own lib directory and config; the browser half keeps its receipts. Rotation of the stage bot's own logs is unchanged (see "Deploy reliability").

**Operations.** A red `stage-qa` is a verdict on that PR: open the `Stage QA` run linked from the status (the job log has every case's `SMOKE PASS/FAIL` line and the reason; the receipt is on the browser host). `error` means the QA could not run: `slot never ran this commit` (another PR took the slot: re-run `Stage Bot` of this PR), `lock wait timed out` (the other repository's stage run held the browser host's lock: re-run `Stage QA`), `not provisioned` (qa-cli logged out, ssh key, config, sudoers or the browser host unreachable: read the `STAGE_QA_NOT_PROVISIONED:` line, or `the browser host connection ended with exit status 255`), `refused` (read the reason in the log: an invalid report or a case list below the floor). If the `odroid-esb-qa` runner is off the `qa` job stays queued, no status appears and `gh ship` refuses: it fails closed. To revoke the QA login: Telegram, Settings, Devices, end the web session; to revoke the odroid's access remove the `esb-stage-qa-odroid` line from the server user's `~/.ssh/authorized_keys`.

---

## Manual Operations

All as `www-data` on odroid (`ssh root@odroidn2`, then `su - www-data`).

```bash
pm2 list
pm2 restart expensesyncbot
pm2 stop expensesyncbot
pm2 reload expensesyncbot              # zero-downtime
pm2 logs expensesyncbot --lines 100 --nostream
pm2 logs expensesyncbot --err

# After editing .env
cd /var/www/ExpenseSyncBot && pm2 reload ecosystem.config.cjs --update-env
```

### Backup / restore the database

Daily backups land in `data/backups/` (cron, keeps 30 days).

```bash
cd /var/www/ExpenseSyncBot/data
pm2 stop expensesyncbot bank-sync
gunzip -c backups/expenses_YYYY-MM-DD_HH-MM-SS.db.gz > expenses.db && rm -f expenses.db-wal expenses.db-shm
pm2 start expensesyncbot bank-sync
```

---

## Troubleshooting

### Bot is not starting

1. `pm2 describe expensesyncbot`, `pm2 logs expensesyncbot --lines 50 --nostream`
2. Run manually: `cd /var/www/ExpenseSyncBot && bun run index.ts`
3. Common causes: missing/invalid `.env`, port 3311 in use, `data/` not writable by www-data,
   native module built for another arch (re-run `bun install` on the odroid).

### Public URLs return 502

1. Origin: `curl -H 'Host: finbot.mextner.com' http://127.0.0.1/health` on odroid
2. Tunnel: `systemctl status cloudflared` / `journalctl -u cloudflared -n 50` on odroid; tunnel health in the Cloudflare dashboard

### GitHub Actions deployment fails

1. Runner online? The runner watchdog alerts the admin chat when it is not; check by hand with
   `gh api repos/alex-mextner/ExpenseSyncBot/actions/runners` (needs admin rights) or `gh workflow run runner-watchdog.yml`
2. On odroid: `systemctl status 'actions.runner.*'`, logs in `/var/www/actions-runner/_diag/`
3. `www-data` must own `/var/www/ExpenseSyncBot` and be able to `git pull` (`/var/www/.ssh/id_ed25519`)

### PM2 process not reloading

```bash
pm2 ping
pm2 kill
pm2 start ecosystem.config.cjs
pm2 save
```

---

## Security Notes

1. **Never commit `.env`** — it's in `.gitignore`
2. **Keep `ENCRYPTION_KEY` secret** — encrypts Google tokens
3. **Self-hosted runner = code execution on the home server** — keep the fork-PR and bot-PR guards in `stage-bot.yml` and fork-PR workflow approval for all outside contributors
4. **Database backups should be encrypted** if stored externally
5. The origin Caddy is plain HTTP and reachable from the LAN and tailnet only (no router port forwards; cloudflared dials out)

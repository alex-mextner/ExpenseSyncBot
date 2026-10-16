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
6. [Manual Operations](#manual-operations)
7. [Troubleshooting](#troubleshooting)

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
```

The healthcheck probes the public URL (`https://finbot.mextner.com/health`), so it alerts on tunnel or bot failure alike.
A failed probe is retried 3 times, 15 s apart, before alerting, so a deploy's ~10 s PM2 restart doesn't trigger a false alert. Log lines and alert times are UTC.

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
   - `git pull origin main`, `git submodule update --init`
   - `bun install` (root + ZenPlugins), Mini App build
   - log rotation, `caddy reload`, pm2-logrotate config
   - `pm2 reload ecosystem.config.cjs --update-env`
4. Telegram notification to the admin chat
5. If the stage bot runs from the main checkout (no PR holds the stage slot), it is restarted on
   the new commit; a stage bot running a PR worktree is left alone (`scripts/stage-follow-main.sh`)

`.env` and `data/` are never touched by the deploy. Migrations run on bot startup.

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

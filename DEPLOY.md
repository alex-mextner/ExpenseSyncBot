# Deployment Guide for ExpenseSyncBot

The bot runs on a home server (**odroidn2**, Odroid N2, Armbian, aarch64). Public HTTPS
traffic enters through the Digital Ocean droplet (**do-edge**), whose Caddy terminates TLS
for `*.invntrm.ru` and reverse-proxies to the home server over Tailscale.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Home Server Setup](#home-server-setup)
3. [Edge Proxy (Digital Ocean)](#edge-proxy-digital-ocean)
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
                                 │ Tailscale (100.116.57.66)
                                 │
Users ── HTTPS ──► Caddy on DO edge (104.248.84.190, Let's Encrypt)
                   expense-sync-bot.invntrm.ru, expense-sync-bot-app.invntrm.ru,
                   expense-sync-stage-bot.invntrm.ru, expense-sync-stage-bot-app.invntrm.ru

GitHub push to main ──► Actions: check (ubuntu-latest) ──► deploy (self-hosted runner on odroid)
```

The bot itself only needs outbound internet (Telegram long polling, Google, AI APIs, banks).
The edge proxy is required for the OAuth callback, the Mini App and its `/api`.
If the edge is down, the bot keeps working; only the Mini App and `/connect` OAuth stop.

| Host | Access | Role |
|---|---|---|
| odroidn2 | `ssh root@odroidn2` (Tailscale) | bot, data, Caddy origin, GitHub runner |
| do-edge | `ssh root@104.248.84.190` | TLS edge only (also hosts unrelated projects) |

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
cp .env.example .env && nano .env   # GOOGLE_REDIRECT_URI=https://expense-sync-bot.invntrm.ru/callback, OAUTH_SERVER_PORT=3311
bun install
bun install --cwd src/services/bank/ZenPlugins
bunx playwright install chromium     # table renderer (as root: bunx playwright install-deps chromium)
(cd miniapp && bun install --frozen-lockfile && bun run build)
```

Stage bot: `.env.stage` in the repo dir holds overrides (stage `BOT_TOKEN`, port 3312, `./data/expenses-stage.db`);
its working directory is `/var/www/ExpenseSyncBot-stage`.

### 4. PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
# as root — registers pm2-www-data.service for boot:
env PATH=$PATH:/var/www/.nvm/versions/node/v22.17.0/bin /var/www/.bun/bin/pm2 startup systemd -u www-data --hp /var/www
```

`ecosystem.config.cjs` pins `TZ=UTC`: cron schedules (exchange rates, monthly tab clone) and date math
have always run in UTC, while the odroid system clock is Europe/Belgrade.

### 5. Caddy (origin)

```bash
ln -sf /var/www/ExpenseSyncBot/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
```

The repo `Caddyfile` uses `http://` site addresses: TLS lives on the edge. Deploys run
`caddy reload --config /etc/caddy/Caddyfile`, so Caddyfile changes ship with the code.

### 6. Cron (as www-data, `crontab -e`)

```cron
0 3 * * * cd /var/www/ExpenseSyncBot && PATH=/var/www/.bun/bin:$PATH ./scripts/backup-db.sh >> logs/backup.log 2>&1
*/2 * * * * /var/www/ExpenseSyncBot/scripts/healthcheck-alert.sh >> /var/www/ExpenseSyncBot/logs/healthcheck.log 2>&1
```

The healthcheck probes the public URL, so it alerts on edge, tunnel or bot failure alike.

### 7. LAN address

The odroid gets its LAN address (currently 192.168.0.38) from DHCP without a reservation; it may change.
Nothing depends on it: the edge and CI use Tailscale (`odroidn2`, 100.116.57.66).

---

## Edge Proxy (Digital Ocean)

The droplet is in the tailnet as `do-edge` (`tailscale up --hostname=do-edge --accept-dns=false`;
`--accept-dns=false` keeps MagicDNS from touching the other projects on the droplet).

The droplet's `/etc/caddy/Caddyfile` is shared with other projects and imports `/var/www/*/Caddyfile`
and `/etc/caddy/Caddyfile.d/*`. The old checkout's `Caddyfile` was renamed to
`/var/www/ExpenseSyncBot/Caddyfile.migrated-to-odroid` so the glob no longer picks it up;
the edge config lives in `/etc/caddy/Caddyfile.d/expensesyncbot.caddy`:

```caddy
expense-sync-bot.invntrm.ru, expense-sync-bot-app.invntrm.ru, expense-sync-stage-bot.invntrm.ru, expense-sync-stage-bot-app.invntrm.ru,
expense-sync-bot.mextner.com, expense-sync-bot-app.mextner.com, expense-sync-stage-bot.mextner.com, expense-sync-stage-bot-app.mextner.com {
	# Origin is the home server (odroidn2) over Tailscale; Host header is preserved.
	reverse_proxy 100.116.57.66:80 {
		lb_try_duration 10s
		lb_try_interval 500ms
	}
	log {
		output file /var/log/caddy/expensesyncbot.log
		format console
	}
}
```

Apply with `caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy`.
Google OAuth redirect URIs and the BotFather Mini App URL stay on `*.invntrm.ru`.

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
lives in this repository — fork PRs never reach the home server.

Secrets used: `BOT_TOKEN`, `BOT_ADMIN_CHAT_ID` (deploy notifications).

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

1. Origin: `curl -H 'Host: expense-sync-bot.invntrm.ru' http://127.0.0.1/health` on odroid
2. Tunnel: `tailscale ping odroidn2` on the droplet; `tailscale status` on both
3. Edge: `journalctl -u caddy -n 50` on the droplet

### GitHub Actions deployment fails

1. Runner online? `gh api repos/alex-mextner/ExpenseSyncBot/actions/runners`
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
3. **Self-hosted runner = code execution on the home server** — keep the fork-PR guard in `stage-bot.yml`
4. **Database backups should be encrypted** if stored externally
5. The origin Caddy is plain HTTP and reachable from the LAN and tailnet only (no router port forwards)

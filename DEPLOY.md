# Deployment Guide for ExpenseSyncBot

This guide covers the initial setup and automated deployment to Digital Ocean.

## Table of Contents

1. [Initial Server Setup](#initial-server-setup)
2. [GitHub Actions Setup](#github-actions-setup)
3. [Automated Deployment](#automated-deployment)
4. [Manual Operations](#manual-operations)
5. [Troubleshooting](#troubleshooting)

---

## Initial Server Setup

These steps need to be done **once** on the Digital Ocean server.

### 1. SSH into the server

```bash
ssh www-data@104.248.84.190
```

### 2. Create project directory

```bash
sudo mkdir -p /var/www/ExpenseSyncBot
sudo chown www-data:www-data /var/www/ExpenseSyncBot
cd /var/www/ExpenseSyncBot
```

**Note:** Files will be deployed via rsync from GitHub Actions. No need to clone the repository manually.

### 3. Create the data directory

```bash
mkdir -p data
```

### 5. Create `.env` file

```bash
cp .env.example .env
nano .env
```

Fill in the following values:

```env
# From @BotFather
BOT_TOKEN=your_bot_token_here

# From Google Cloud Console
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=https://expense-sync-bot.invntrm.ru/callback

# OAuth server port
OAUTH_SERVER_PORT=3000

# Database (default path is fine)
DATABASE_PATH=./data/expenses.db

# Generate with: openssl rand -hex 32
ENCRYPTION_KEY=your_32_byte_hex_key

# Environment
NODE_ENV=production
```

### 6. Create logs directory

```bash
mkdir -p logs
```

### 7. Test the bot manually (optional)

```bash
bun run index.ts
```

Press Ctrl+C to stop.

### 8. Install PM2 globally (if not installed)

```bash
npm install -g pm2
# or
bun add -g pm2
```

### 9. Start the bot with PM2

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

**Note:** `pm2 startup` will show you a command to run with sudo. Copy and execute it to enable PM2 auto-start on server reboot.

### 10. Check PM2 status

```bash
pm2 list
pm2 status expensesyncbot
```

### 11. View logs

```bash
# Follow logs in real-time
pm2 logs expensesyncbot

# View recent logs
pm2 logs expensesyncbot --lines 100

# Clear logs
pm2 flush
```

### 12. Configure Caddy

```bash
# Copy Caddyfile to Caddy config directory
sudo cp Caddyfile /etc/caddy/Caddyfile

# Test configuration
sudo caddy validate --config /etc/caddy/Caddyfile

# Reload Caddy
sudo systemctl reload caddy

# Check Caddy status
sudo systemctl status caddy
```

### 13. Update Google Cloud Console

Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials) and update the OAuth redirect URI to:

```
https://expense-sync-bot.invntrm.ru/callback
```

---

## GitHub Actions Setup

### 1. Generate SSH key on the server

On the Digital Ocean server, generate a new SSH key for GitHub Actions:

```bash
ssh-keygen -t ed25519 -C "github-actions" -f ~/.ssh/github-actions
```

**Don't set a passphrase** (just press Enter when prompted).

### 2. Add public key to authorized_keys

```bash
cat ~/.ssh/github-actions.pub >> ~/.ssh/authorized_keys
```

### 3. Copy private key

```bash
cat ~/.ssh/github-actions
```

Copy the entire output (including `-----BEGIN OPENSSH PRIVATE KEY-----` and `-----END OPENSSH PRIVATE KEY-----`).

### 4. Add to GitHub Secrets

1. Go to your GitHub repository: https://github.com/alex-mextner/ExpenseSyncBot
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Name: `DIGITAL_OCEAN_SSH_KEY`
5. Value: Paste the private key from step 3
6. Click **Add secret**

### 5. Test the workflow

Push a commit to the `main` branch or manually trigger the workflow:

1. Go to **Actions** tab
2. Select **Deploy to Digital Ocean**
3. Click **Run workflow** → **Run workflow**

---

## Automated Deployment

Once setup is complete, deployment happens automatically:

1. Push code to the `main` branch
2. GitHub Actions triggers the workflow
3. The workflow:
   - SSH into the server
   - Pulls latest changes from `main`
   - Installs dependencies with `bun install`
   - Restarts the systemd service
4. The bot is now running with the latest code

### What happens during deployment:

- ✅ Code is updated (`git pull`)
- ✅ Dependencies are installed
- ✅ Database migrations run automatically on bot startup
- ✅ Service is restarted
- ❌ `.env` file is **not** touched
- ❌ `data/` directory is **not** touched

---

## Manual Operations

### Restart the bot

```bash
pm2 restart expensesyncbot
```

### Stop the bot

```bash
pm2 stop expensesyncbot
```

### Start the bot

```bash
pm2 start expensesyncbot
```

### Reload the bot (zero-downtime)

```bash
pm2 reload expensesyncbot
```

### View logs

```bash
# Real-time logs
pm2 logs expensesyncbot

# Last 100 lines
pm2 logs expensesyncbot --lines 100

# View only error logs
pm2 logs expensesyncbot --err

# Clear all logs
pm2 flush
```

### Update environment variables

```bash
cd /var/www/ExpenseSyncBot
nano .env
pm2 reload expensesyncbot --update-env
```

### Backup the database

```bash
cd /var/www/ExpenseSyncBot/data
cp expenses.db expenses.db.backup.$(date +%Y%m%d_%H%M%S)
```

### Restore database from backup

```bash
cd /var/www/ExpenseSyncBot/data
cp expenses.db.backup.YYYYMMDD_HHMMSS expenses.db
pm2 restart expensesyncbot
```

---

## Troubleshooting

### Bot is not starting

1. Check PM2 status:
   ```bash
   pm2 status
   pm2 describe expensesyncbot
   ```

2. Check the logs:
   ```bash
   pm2 logs expensesyncbot --lines 50
   ```

3. Try to start manually:
   ```bash
   cd /var/www/ExpenseSyncBot
   bun run index.ts
   ```

4. Common issues:
   - Missing `.env` file
   - Invalid environment variables
   - Port 3000 already in use
   - Database permissions issue
   - PM2 not installed or not in PATH

### GitHub Actions deployment fails

1. Check the GitHub Actions logs in the repository
2. Verify SSH key is correct in GitHub Secrets
3. Verify `www-data` user has permissions on `/var/www/ExpenseSyncBot`
4. Check if PM2 is installed:
   ```bash
   pm2 --version
   ```
5. Check if the bot is running:
   ```bash
   pm2 list
   ```

### OAuth callback not working

1. Verify Caddy is running:
   ```bash
   sudo systemctl status caddy
   ```

2. Check Caddy logs:
   ```bash
   sudo journalctl -u caddy -f
   ```

3. Verify redirect URI in Google Cloud Console matches:
   ```
   https://expense-sync-bot.invntrm.ru/callback
   ```

4. Test the OAuth endpoint:
   ```bash
   curl https://expense-sync-bot.invntrm.ru/health
   ```

### Bot responds slowly or times out

1. Check if bot process is running:
   ```bash
   ps aux | grep bun
   ```

2. Check system resources:
   ```bash
   top
   df -h
   free -m
   ```

3. Check database size:
   ```bash
   ls -lh /var/www/ExpenseSyncBot/data/
   ```

### PM2 process not reloading

If deployment fails with PM2 errors:

```bash
# Check if PM2 daemon is running
pm2 ping

# Check PM2 logs
pm2 logs

# If PM2 is broken, try resetting it
pm2 kill
pm2 start ecosystem.config.js
pm2 save
```

---

## Security Notes

1. **Never commit `.env` file** - It's in `.gitignore`
2. **Keep `ENCRYPTION_KEY` secret** - Used to encrypt Google tokens
3. **SSH key is for GitHub Actions only** - Don't share it
4. **Database backups should be encrypted** if stored externally
5. **Review Caddy logs regularly** for unusual OAuth activity

---

## Architecture Overview

```
GitHub (main branch push)
    ↓
GitHub Actions Workflow
    ↓
SSH to Digital Ocean (www-data@104.248.84.190)
    ↓
/var/www/ExpenseSyncBot
    ├── rsync files (excluding .git, node_modules, data)
    ├── bun install
    └── pm2 reload
          ↓
    PM2 process manager
          ↓
    Bun runtime runs index.ts
          ├── Bot connects to Telegram
          ├── OAuth server on port 3000
          └── SQLite database in ./data/
                ↓
    Caddy reverse proxy
          ↓
    expense-sync-bot.invntrm.ru (HTTPS)
```

---

## Useful Commands Reference

```bash
# PM2 management
pm2 list
pm2 status expensesyncbot
pm2 start expensesyncbot
pm2 stop expensesyncbot
pm2 restart expensesyncbot
pm2 reload expensesyncbot
pm2 delete expensesyncbot

# Logs
pm2 logs expensesyncbot
pm2 logs expensesyncbot --lines 100
pm2 logs expensesyncbot --err
pm2 flush

# PM2 process info
pm2 describe expensesyncbot
pm2 monit

# Caddy
sudo systemctl reload caddy
sudo systemctl status caddy
sudo journalctl -u caddy -f

# Database
sqlite3 /var/www/ExpenseSyncBot/data/expenses.db
# Inside sqlite3:
# .tables
# .schema users
# SELECT * FROM users;
# .quit

# Check bot process
ps aux | grep bun
pm2 list

# Test OAuth endpoint
curl https://expense-sync-bot.invntrm.ru/health

# Check disk space
df -h
du -sh /var/www/ExpenseSyncBot/data/
```

---

## Contact

For issues or questions:
- GitHub Issues: https://github.com/alex-mextner/ExpenseSyncBot/issues

// Drives scripts/stage-follow-main.sh (run by deploy.yml after a prod deploy) with a
// stand-in pm2 whose process list mirrors the shapes pm2 reports on the server, and a
// curl that records Telegram warnings instead of sending them.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '../../scripts/stage-follow-main.sh');
const BUN = '/var/www/.bun/bin/bun --no-env-file --env-file=/var/www/ExpenseSyncBot-stage/.env';

// Stand-in pm2: `jlist` prints $FIX/jlist (or $FIX/jlist.after once `restart` ran),
// `restart` exits with $RESTART_EXIT; every call is logged to $FIX/calls.
const PM2_STUB = `#!/usr/bin/env bash
echo "$*" >> "$FIX/calls"
case "$1" in
  jlist)
    if [ -f "$FIX/restarted" ] && [ -f "$FIX/jlist.after" ]; then cat "$FIX/jlist.after"; else cat "$FIX/jlist"; fi ;;
  restart)
    touch "$FIX/restarted"
    exit "\${RESTART_EXIT:-0}" ;;
esac
`;

const CURL_STUB = `#!/usr/bin/env bash
prev=""
for arg in "$@"; do
  if [ "$prev" = "-d" ]; then printf '%s' "$arg" | jq -c '.text' >> "$FIX/telegram"; fi
  prev="$arg"
done
`;

interface Pm2Process {
  name: string;
  pm2_env: { status: string; pm_exec_path: string; args: string[] | null };
}

const prod: Pm2Process = {
  name: 'expensesyncbot',
  pm2_env: { status: 'online', pm_exec_path: '/var/www/ExpenseSyncBot/start.sh', args: null },
};
// Exactly how stage-bot.yml's `pm2 start "<cmd>"` shows up in `pm2 jlist` on odroid.
const stage = (codeDir: string, status = 'online'): Pm2Process => ({
  name: 'expensesyncbot-stage',
  pm2_env: { status, pm_exec_path: '/usr/bin/bash', args: ['-c', `${BUN} ${codeDir}/index.ts`] },
});
const stageOnMain = stage('/var/www/ExpenseSyncBot');
const stageOnPr = stage('/var/www/ExpenseSyncBot/.claude/worktrees/chore/deploy-docs-wd500');

function followMain(
  jlist: Pm2Process[] | string,
  { afterRestart, restartExit = 0 }: { afterRestart?: Pm2Process[]; restartExit?: number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'stage-follow-main-'));
  const bin = join(dir, 'bin');
  const fix = join(dir, 'fixtures');
  mkdirSync(bin);
  mkdirSync(fix);
  writeFileSync(join(bin, 'pm2'), PM2_STUB, { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), CURL_STUB, { mode: 0o755 });
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(fix, 'jlist'), typeof jlist === 'string' ? jlist : JSON.stringify(jlist));
  if (afterRestart) writeFileSync(join(fix, 'jlist.after'), JSON.stringify(afterRestart));

  const result = spawnSync('bash', [SCRIPT], {
    env: {
      PATH: `${bin}:${process.env['PATH']}`,
      FIX: fix,
      PM2: join(bin, 'pm2'),
      RESTART_EXIT: String(restartExit),
      BOT_TOKEN: 'test-token',
      ADMIN_CHAT_ID: '42',
      COMMIT_SHA: 'abcdef1234567890',
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
  const lines = (file: string) =>
    existsSync(join(fix, file))
      ? readFileSync(join(fix, file), 'utf8').split('\n').filter(Boolean)
      : [];
  return {
    status: result.status,
    stdout: result.stdout,
    restarted: lines('calls').some((call) => call.startsWith('restart expensesyncbot-stage')),
    telegram: lines('telegram').map((line): string => JSON.parse(line)),
  };
}

describe('stage-follow-main.sh', () => {
  test('stage runs the main checkout: restarts it on the new commit', () => {
    const r = followMain([prod, stageOnMain]);
    expect(r.status).toBe(0);
    expect(r.restarted).toBe(true);
    expect(r.stdout).toContain('✅ Stage bot online on main abcdef1');
    expect(r.telegram).toEqual([]);
  });

  test('stage started by start-stage.sh runs main too: restarts it', () => {
    const viaScript: Pm2Process = {
      name: 'expensesyncbot-stage',
      pm2_env: {
        status: 'online',
        pm_exec_path: '/var/www/ExpenseSyncBot/start-stage.sh',
        args: null,
      },
    };
    const r = followMain([prod, viaScript]);
    expect(r.status).toBe(0);
    expect(r.restarted).toBe(true);
  });

  test('stage runs a PR worktree: left untouched', () => {
    const r = followMain([prod, stageOnPr]);
    expect(r.status).toBe(0);
    expect(r.restarted).toBe(false);
    expect(r.stdout).toContain('runs a PR worktree');
    expect(r.telegram).toEqual([]);
  });

  test('no stage process at all: nothing to do', () => {
    const r = followMain([prod]);
    expect(r.status).toBe(0);
    expect(r.restarted).toBe(false);
    expect(r.telegram).toEqual([]);
  });

  test('stage does not come back online: warns the admin and fails the step', () => {
    const r = followMain([prod, stageOnMain], {
      afterRestart: [prod, stage('/var/www/ExpenseSyncBot', 'errored')],
    });
    expect(r.status).toBe(1);
    expect(r.telegram).toHaveLength(1);
    expect(r.telegram[0]).toStartWith('⚠️ <b>Stage bot was not moved to the new main</b>');
    expect(r.telegram[0]).toContain('status: <code>errored</code>');
  });

  test('pm2 restart fails: warns the admin and fails the step', () => {
    const r = followMain([prod, stageOnMain], { restartExit: 1 });
    expect(r.status).toBe(1);
    expect(r.telegram[0]).toContain('pm2 restart failed');
  });

  test('unreadable process list: warns instead of silently skipping', () => {
    const r = followMain('not json');
    expect(r.status).toBe(1);
    expect(r.restarted).toBe(false);
    expect(r.telegram[0]).toContain('could not read the pm2 process list');
  });
});

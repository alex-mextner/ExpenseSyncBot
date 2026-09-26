import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const SCRIPT = join(ROOT, 'scripts/install-git-hooks.sh');
const USER_HOOK = '#!/bin/sh\n# the user-global hook dispatcher\n';

/**
 * A throwaway HOME whose global git config can point core.hooksPath at a shared directory that
 * already holds a user hook. Nothing here can reach the real HOME or its global hooks.
 */
function sandbox({ globalHooksPath }: { globalHooksPath: boolean }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hcb-hooks-')));
  const home = join(dir, 'home');
  const globalHooks = join(home, '.config/git/hooks');
  mkdirSync(globalHooks, { recursive: true });
  writeFileSync(join(globalHooks, 'pre-commit'), USER_HOOK, { mode: 0o755 });
  const core = globalHooksPath ? `[core]\n\thooksPath = ${globalHooks}\n` : '';
  writeFileSync(
    join(home, '.gitconfig'),
    `${core}[user]\n\tname = t\n\temail = t@example.invalid\n`,
  );
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  const env: Record<string, string | undefined> = {
    ...inherited,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    // lefthook's own postinstall is a no-op when CI is set; the hazard must be exercised here too.
    CI: '',
  };
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const initRepo = (name = 'repo') => {
    const repo = join(dir, name);
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q');
    return repo;
  };
  const globalHooksUntouched = () => {
    expect(readdirSync(globalHooks)).toEqual(['pre-commit']);
    expect(readFileSync(join(globalHooks, 'pre-commit'), 'utf8')).toBe(USER_HOOK);
  };
  return { dir, env, git, initRepo, globalHooksUntouched };
}

/** Runs the guard once; a stand-in lefthook (unless `withLefthook` is false) records this run's calls. */
function runGuard(box: ReturnType<typeof sandbox>, cwd: string, { withLefthook = true } = {}) {
  const bin = join(box.dir, withLefthook ? 'bin' : 'bin-git-only');
  const calls = join(box.dir, 'lefthook.calls');
  rmSync(calls, { force: true });
  mkdirSync(bin, { recursive: true });
  if (withLefthook) {
    writeFileSync(join(bin, 'lefthook'), `#!/bin/sh\necho "$*" >> '${calls}'\n`, { mode: 0o755 });
  } else if (!existsSync(join(bin, 'git'))) {
    const gitBinary = Bun.which('git');
    if (!gitBinary) throw new Error('git is not on PATH');
    symlinkSync(gitBinary, join(bin, 'git'));
  }
  const path = withLefthook ? `${bin}:${box.env['PATH']}` : `${bin}:/usr/bin:/bin`;
  const result = spawnSync('sh', [SCRIPT], {
    cwd,
    env: { ...box.env, PATH: path },
    encoding: 'utf8',
  });
  const recorded = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls: recorded };
}

describe('postinstall git hook guard', () => {
  test('a global core.hooksPath outside the repository is left alone', () => {
    const box = sandbox({ globalHooksPath: true });
    try {
      const run = runGuard(box, box.initRepo());
      expect(run.status).toBe(0);
      expect(run.calls).toEqual([]);
      expect(run.stderr).toContain('outside this repository');
      box.globalHooksUntouched();
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  test('a local core.hooksPath pointing outside the repository is left alone', () => {
    const box = sandbox({ globalHooksPath: false });
    try {
      const repo = box.initRepo();
      box.git(repo, 'config', 'core.hooksPath', '../shared-hooks');
      expect(runGuard(box, repo).calls).toEqual([]);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  test("the repository's own hooks directory is installed, also from a linked worktree", () => {
    const box = sandbox({ globalHooksPath: true });
    try {
      const repo = box.initRepo();
      box.git(repo, 'config', 'core.hooksPath', join(repo, '.git/hooks'));
      box.git(repo, 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'base');
      box.git(repo, 'worktree', 'add', '-q', join(box.dir, 'linked'));
      expect(runGuard(box, repo).calls).toEqual(['install --force']);
      expect(runGuard(box, join(box.dir, 'linked')).calls).toEqual(['install --force']);
      box.globalHooksUntouched();
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  test('a core.hooksPath redirected to another directory inside the git dir is installed', () => {
    const box = sandbox({ globalHooksPath: true });
    try {
      const repo = box.initRepo();
      mkdirSync(join(repo, '.git/custom-hooks'));
      box.git(repo, 'config', 'core.hooksPath', join(repo, '.git/custom-hooks'));
      expect(runGuard(box, repo).calls).toEqual(['install --force']);
      box.globalHooksUntouched();
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  test('without any core.hooksPath the default .git/hooks is installed', () => {
    const box = sandbox({ globalHooksPath: false });
    try {
      expect(runGuard(box, box.initRepo()).calls).toEqual(['install --force']);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  test('outside a git work tree, or without lefthook, nothing is installed', () => {
    const box = sandbox({ globalHooksPath: true });
    try {
      const plain = join(box.dir, 'plain');
      mkdirSync(plain);
      const outside = runGuard(box, plain);
      expect(outside.status).toBe(0);
      expect(outside.calls).toEqual([]);
      const noLefthook = runGuard(box, box.initRepo(), { withLefthook: false });
      expect(noLefthook.status).toBe(0);
      expect(noLefthook.stdout).toContain('lefthook is not installed');
      box.globalHooksUntouched();
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  test('a real bun install of this manifest leaves a global core.hooksPath untouched', () => {
    // The 2026-09-26 incident: lefthook's own dependency postinstall runs `lefthook install -f`,
    // which writes into a global core.hooksPath. The repository's root postinstall must not either.
    const cache = spawnSync(process.execPath, ['pm', 'cache'], { encoding: 'utf8' }).stdout.trim();
    const box = sandbox({ globalHooksPath: true });
    try {
      const repo = box.initRepo();
      mkdirSync(join(repo, 'scripts'));
      for (const file of [
        'package.json',
        'bun.lock',
        'lefthook.yml',
        'scripts/install-git-hooks.sh',
      ]) {
        cpSync(join(ROOT, file), join(repo, file));
      }
      const install = spawnSync(process.execPath, ['install', '--frozen-lockfile'], {
        cwd: repo,
        env: { ...box.env, BUN_INSTALL_CACHE_DIR: cache },
        encoding: 'utf8',
        timeout: 180_000,
      });
      expect({
        status: install.status,
        stderr: install.status === 0 ? '' : install.stderr,
      }).toEqual({
        status: 0,
        stderr: '',
      });
      box.globalHooksUntouched();
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 240_000);
});

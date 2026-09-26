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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hooks-guard-')));
  const home = join(dir, 'home');
  const globalHooks = join(home, '.config/git/hooks');
  mkdirSync(globalHooks, { recursive: true });
  writeFileSync(join(globalHooks, 'pre-commit'), USER_HOOK, { mode: 0o755 });
  const core = globalHooksPath ? `[core]\n\thooksPath = ${globalHooks}\n` : '';
  writeFileSync(
    join(home, '.gitconfig'),
    `${core}[user]\n\tname = t\n\temail = t@example.invalid\n`,
  );
  // lefthook's own postinstall is skipped when CI (or LEFTHOOK=0) is set; drop both so the
  // hazard is exercised here exactly as on a developer machine.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('GIT_') && key !== 'CI' && key !== 'LEFTHOOK',
    ),
  );
  const env: Record<string, string | undefined> = {
    ...inherited,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
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
  return { dir, env, git, initRepo, globalHooks, globalHooksUntouched };
}

/** Runs the guard once; a stand-in lefthook (unless `withLefthook` is false) records this run's calls. */
function runGuard(
  box: ReturnType<typeof sandbox>,
  cwd: string,
  { withLefthook = true, lefthookExit = 0 }: { withLefthook?: boolean; lefthookExit?: number } = {},
) {
  const bin = join(box.dir, withLefthook ? 'bin' : 'bin-git-only');
  const calls = join(box.dir, 'lefthook.calls');
  rmSync(calls, { force: true });
  mkdirSync(bin, { recursive: true });
  if (withLefthook) {
    writeFileSync(
      join(bin, 'lefthook'),
      `#!/bin/sh\necho "$*" >> '${calls}'\nexit ${lefthookExit}\n`,
      {
        mode: 0o755,
      },
    );
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

/** A real `bun install --frozen-lockfile --offline` of this repository's manifest inside the sandbox. */
function realInstall(box: ReturnType<typeof sandbox>) {
  const cache = spawnSync(process.execPath, ['pm', 'cache'], { encoding: 'utf8' }).stdout.trim();
  const repo = box.initRepo();
  mkdirSync(join(repo, 'scripts'));
  for (const file of ['package.json', 'bun.lock', 'lefthook.yml', 'scripts/install-git-hooks.sh']) {
    cpSync(join(ROOT, file), join(repo, file));
  }
  const install = spawnSync(process.execPath, ['install', '--frozen-lockfile', '--offline'], {
    cwd: repo,
    env: { ...box.env, BUN_INSTALL_CACHE_DIR: cache },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { repo, status: install.status, output: `${install.stdout}\n${install.stderr}` };
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

  test('a .git/hooks symlink into the global hooks directory is judged by its target', () => {
    const box = sandbox({ globalHooksPath: false });
    try {
      const repo = box.initRepo();
      rmSync(join(repo, '.git/hooks'), { recursive: true, force: true });
      symlinkSync(box.globalHooks, join(repo, '.git/hooks'), 'dir');
      expect(runGuard(box, repo).calls).toEqual([]);
      box.globalHooksUntouched();
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

  test('a core.hooksPath inside the git dir is installed, even before that directory exists', () => {
    const box = sandbox({ globalHooksPath: true });
    try {
      const repo = box.initRepo();
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

  test('a failing lefthook install warns without failing the install', () => {
    const box = sandbox({ globalHooksPath: false });
    try {
      const run = runGuard(box, box.initRepo(), { lefthookExit: 1 });
      expect(run.status).toBe(0);
      expect(run.calls).toEqual(['install --force']);
      expect(run.stderr).toContain('lefthook install failed');
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

  test('a real bun install leaves a global core.hooksPath untouched', () => {
    // lefthook's own dependency postinstall runs `lefthook install -f`, which writes into a global
    // core.hooksPath (the 2026-09-26 incident); the root postinstall must not write there either.
    const box = sandbox({ globalHooksPath: true });
    try {
      const install = realInstall(box);
      expect({
        status: install.status,
        output: install.status === 0 ? '' : install.output,
      }).toEqual({
        status: 0,
        output: '',
      });
      // The guard itself ran and refused, rather than the root postinstall being skipped.
      expect(install.output).toContain('outside this repository');
      box.globalHooksUntouched();
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 180_000);

  test("a real bun install installs lefthook into the repository's own hooks", () => {
    const box = sandbox({ globalHooksPath: false });
    try {
      const install = realInstall(box);
      expect(install.status).toBe(0);
      expect(readFileSync(join(install.repo, '.git/hooks/pre-commit'), 'utf8')).toContain(
        'lefthook',
      );
      box.globalHooksUntouched();
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 180_000);
});

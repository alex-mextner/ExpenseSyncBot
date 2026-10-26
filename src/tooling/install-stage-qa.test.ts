// scripts/install-stage-qa.sh (odroid, root) and scripts/install-stage-qa-pc.sh (PC, normal user) are run by
// hand from a reviewed main checkout; the by-hand steps decide what is trusted, so the installers refuse
// anything that is not committed code on origin/main. The tests run the real scripts against a real git
// checkout; only the fixed `readonly` paths and ids at the top are rewritten to point into a temp dir (the
// scripts take no environment overrides, which is what keeps a hostile environment from redirecting them).
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { type SpawnSyncReturns, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import {
  REPO,
  REQUIRED_CASES,
  type TempRoot,
  tempRoot,
  writeExecutable,
} from '../test-utils/stage-qa-fixtures';

setDefaultTimeout(60_000);

const ODROID_INSTALLER = join(REPO, 'scripts/install-stage-qa.sh');
const PC_INSTALLER = join(REPO, 'scripts/install-stage-qa-pc.sh');
const SOURCES = [
  'scripts/odroid-stage-qa-report.py',
  'scripts/stage-qa-pc.py',
  'scripts/stage-smoke.py',
];

let temp: TempRoot | null = null;

afterEach(() => {
  temp?.cleanup();
  temp = null;
});

/** Replaces one fixed `readonly NAME=value` line of an installer; fails when the line is not there. */
function rewrite(text: string, replacements: Array<[string, string]>): string {
  let out = text;
  for (const [from, to] of replacements) {
    if (!out.includes(from)) throw new Error(`installer has no line ${from.trim()}`);
    out = out.replace(from, to);
  }
  return out;
}

function git(cwd: string, ...args: string[]): void {
  const done = spawnSync(
    'git',
    [
      '-C',
      cwd,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { encoding: 'utf8' },
  );
  if (done.status !== 0) throw new Error(`git ${args.join(' ')}: ${done.stderr}`);
}

interface Checkout {
  src: string;
  write: (version: string) => void;
  commit: (message: string) => void;
  publish: () => void;
}

function createCheckout(root: string): Checkout {
  const src = join(root, 'checkout');
  mkdirSync(join(src, 'scripts'), { recursive: true });
  const checkout: Checkout = {
    src,
    // The real driver and report script (with a version marker) so the installed layout can be executed.
    write: (version) => {
      for (const rel of SOURCES) {
        writeFileSync(join(src, rel), `${readFileSync(join(REPO, rel), 'utf8')}\n# ${version}\n`);
        chmodSync(join(src, rel), 0o755);
      }
    },
    commit: (message) => {
      git(src, 'add', '-A');
      git(src, 'commit', '-q', '-m', message);
    },
    // As a fetch of the reviewed main would.
    publish: () => git(src, 'update-ref', 'refs/remotes/origin/main', 'HEAD'),
  };
  git(src, 'init', '-q', '-b', 'main');
  checkout.write('one');
  checkout.commit('initial');
  checkout.publish();
  return checkout;
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function leftovers(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes('.new') || name.includes('.bak'));
}

describe('install-stage-qa-pc.sh', () => {
  interface Pc {
    checkout: Checkout;
    home: string;
    lib: string;
    entry: string;
    config: string;
    key: string;
    lock: string;
    script: string;
    install: (...args: string[]) => SpawnSyncReturns<string>;
    makeScript: (replacements?: Array<[string, string]>) => string;
  }

  function createPc(): Pc {
    temp = tempRoot('install-stage-qa-pc-');
    const root = temp.dir;
    const home = join(root, 'home');
    mkdirSync(home);
    const pc: Pc = {
      checkout: createCheckout(root),
      home,
      lib: join(home, '.local/lib/esb-stage-qa'),
      entry: join(home, '.local/bin/esb-stage-qa-pc'),
      config: join(home, '.config/esb-stage-qa/config.json'),
      key: join(home, '.ssh/esb-stage-qa_ed25519'),
      lock: join(home, '.local/state/hypercal-stage-qa/qa.lock'),
      script: '',
      makeScript: (replacements = []) => {
        const script = join(root, 'install-stage-qa-pc.sh');
        writeExecutable(
          script,
          rewrite(readFileSync(PC_INSTALLER, 'utf8'), [
            ['readonly PC_LOCK_WAIT=60\n', 'readonly PC_LOCK_WAIT=1\n'],
            ...replacements,
          ]),
        );
        return script;
      },
      install: (...args) =>
        spawnSync(pc.script, args.length > 0 ? args : [pc.checkout.src], {
          encoding: 'utf8',
          env: { PATH: '/usr/bin:/bin', HOME: home },
        }),
    };
    pc.script = pc.makeScript();
    return pc;
  }

  test('a fresh install lays out the lib, the entry, the config and the key, and leaves nothing behind', () => {
    const pc = createPc();
    const done = pc.install();
    expect(done.status).toBe(0);
    expect(readdirSync(pc.lib).sort()).toEqual(['stage-qa-pc.py', 'stage-smoke.py']);
    for (const name of ['stage-qa-pc.py', 'stage-smoke.py']) {
      expect(readFileSync(join(pc.lib, name), 'utf8')).toEndWith('# one\n');
      expect(modeOf(join(pc.lib, name))).toBe(0o755);
    }
    expect(readFileSync(pc.entry, 'utf8')).toContain(`exec python3 ${pc.lib}/stage-qa-pc.py "$@"`);
    expect(modeOf(pc.entry)).toBe(0o755);
    expect(modeOf(pc.config)).toBe(0o600);
    expect(modeOf(pc.key)).toBe(0o600);
    expect(existsSync(`${pc.key}.pub`)).toBe(true);
    expect(leftovers(join(pc.home, '.local/lib'))).toEqual([]);
    expect(leftovers(join(pc.home, '.config/esb-stage-qa'))).toEqual([]);
  });

  test('the config it writes is accepted by the driver it installs, with the floor of the case list', () => {
    const pc = createPc();
    pc.install();
    const check = spawnSync(
      'python3',
      [
        '-c',
        `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("driver", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
config = module.load_config(sys.argv[2])
print(config.username, config.deny_usernames, config.min_cases, list(config.required_cases), config.lock_file.endswith("hypercal-stage-qa/qa.lock"))
`,
        join(pc.lib, 'stage-qa-pc.py'),
        pc.config,
      ],
      { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: pc.home } },
    );
    expect(check.stderr).toBe('');
    expect(check.stdout.trim()).toBe(
      `ExpenseSyncStageBot ('ExpenseSyncBot',) 5 ${JSON.stringify(REQUIRED_CASES).replaceAll('"', "'").replaceAll(',', ', ')} True`,
    );
  });

  test('the installed driver runs from the installed layout (it finds the engine next to it)', () => {
    const pc = createPc();
    pc.install();
    const done = spawnSync(pc.entry, ['not-a-sha'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: pc.home },
    });
    expect(done.status).toBe(2);
    expect(done.stdout).toBe('STAGE_QA_RESULT status=refused sha=- cases=0 failed=0\n');
  });

  test('prints the authorized_keys line for the read-only report script, and the rollback', () => {
    const pc = createPc();
    const done = pc.install();
    const [type, blob] = readFileSync(`${pc.key}.pub`, 'utf8').split(' ');
    expect(done.stdout).toContain(
      `restrict,command="/usr/local/lib/esb-stage-qa/odroid-stage-qa-report.py" ${type} ${blob} esb-stage-qa-pc\n`,
    );
    expect(done.stdout).toMatch(/^rollback: .+/m);
    expect(done.stdout + done.stderr).not.toContain('PRIVATE KEY');
  });

  test('a reinstall keeps the edited config and the key, backs the lib up, and the printed rollback restores it', () => {
    const pc = createPc();
    expect(pc.install().status).toBe(0);
    writeFileSync(pc.config, '{"edited": true}\n');
    const keyBefore = readFileSync(pc.key, 'utf8');
    pc.checkout.write('two');
    pc.checkout.commit('second');
    pc.checkout.publish();
    const done = pc.install();
    expect(done.status).toBe(0);
    expect(readFileSync(pc.config, 'utf8')).toBe('{"edited": true}\n');
    expect(readFileSync(pc.key, 'utf8')).toBe(keyBefore);
    expect(readFileSync(join(pc.lib, 'stage-qa-pc.py'), 'utf8')).toEndWith('# two\n');
    const backups = readdirSync(join(pc.home, '.local/lib')).filter((n) => n.includes('.bak-'));
    expect(backups.length).toBe(1);
    const rollback = done.stdout.split('\n').find((l) => l.startsWith('rollback: '));
    expect(rollback).toBeDefined();
    const run = spawnSync('bash', ['-c', (rollback ?? '').slice('rollback: '.length)], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(readFileSync(join(pc.lib, 'stage-qa-pc.py'), 'utf8')).toEndWith('# one\n');
  });

  test('refuses uncommitted changes, untracked listed files, and a HEAD that is not on origin/main', () => {
    const pc = createPc();
    writeFileSync(join(pc.checkout.src, 'scripts/stage-smoke.py'), '# edited\n');
    let done = pc.install();
    expect(done.status).toBe(2);
    expect(done.stderr).toContain('uncommitted or untracked changes');
    expect(existsSync(pc.lib)).toBe(false);
    pc.checkout.write('local');
    pc.checkout.commit('local only');
    done = pc.install();
    expect(done.status).toBe(2);
    expect(done.stderr).toContain('not on origin/main');
    expect(existsSync(pc.lib)).toBe(false);
  });

  test('refuses a checkout that is not a git checkout, one without a listed file, and extra arguments', () => {
    const pc = createPc();
    const plain = join(pc.home, 'plain');
    mkdirSync(join(plain, 'scripts'), { recursive: true });
    for (const rel of ['scripts/stage-qa-pc.py', 'scripts/stage-smoke.py']) {
      copyFileSync(join(REPO, rel), join(plain, rel));
    }
    expect(pc.install(plain).stderr).toContain('not a git checkout');
    const empty = join(pc.home, 'empty');
    mkdirSync(empty);
    expect(pc.install(empty).stderr).toContain('unknown checkout layout');
    expect(pc.install(pc.checkout.src, 'x').stderr).toContain('usage:');
    expect(existsSync(pc.lib)).toBe(false);
  });

  test('refuses root', () => {
    const pc = createPc();
    pc.script = pc.makeScript([
      ['readonly FORBIDDEN_EUID=0\n', `readonly FORBIDDEN_EUID=${userInfo().uid}\n`],
    ]);
    const done = pc.install();
    expect(done.status).toBe(2);
    expect(done.stderr).toContain('not root');
  });

  test('waits for a QA run that holds the PC qa lock, gives up with 75 and changes nothing', async () => {
    const pc = createPc();
    mkdirSync(join(pc.lock, '..'), { recursive: true });
    const holder = spawn(
      'python3',
      [
        '-c',
        "import fcntl,sys,time; f=open(sys.argv[1],'a'); fcntl.flock(f, fcntl.LOCK_EX); print('held', flush=True); time.sleep(60)",
        pc.lock,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      const { promise: held, resolve } = Promise.withResolvers<void>();
      holder.stdout.once('data', () => resolve());
      await held;
      const done = pc.install();
      expect(done.status).toBe(75);
      expect(done.stderr).toContain('holds');
      expect(existsSync(pc.lib)).toBe(false);
      expect(existsSync(pc.config)).toBe(false);
    } finally {
      holder.kill('SIGKILL');
    }
  });
});

describe('install-stage-qa.sh', () => {
  interface Odroid {
    checkout: Checkout;
    lib: string;
    script: string;
    install: (...args: string[]) => SpawnSyncReturns<string>;
    makeScript: (replacements?: Array<[string, string]>) => string;
  }

  function createOdroid(): Odroid {
    temp = tempRoot('install-stage-qa-');
    const root = temp.dir;
    const lib = join(root, 'usr/local/lib/esb-stage-qa');
    const { uid, gid, username } = userInfo();
    const odroid: Odroid = {
      checkout: createCheckout(root),
      lib,
      script: '',
      makeScript: (replacements = []) => {
        const script = join(root, 'install-stage-qa.sh');
        writeExecutable(
          script,
          rewrite(readFileSync(ODROID_INSTALLER, 'utf8'), [
            ['readonly LIB_DIR=/usr/local/lib/esb-stage-qa\n', `readonly LIB_DIR=${lib}\n`],
            ['readonly REQUIRED_EUID=0\n', `readonly REQUIRED_EUID=${uid}\n`],
            ['readonly INSTALL_OWNER=root:root\n', `readonly INSTALL_OWNER=${uid}:${gid}\n`],
            ['readonly SERVICE_USER=www-data\n', `readonly SERVICE_USER=${username}\n`],
            ...replacements,
          ]),
        );
        return script;
      },
      install: (...args) =>
        spawnSync(odroid.script, args.length > 0 ? args : [odroid.checkout.src], {
          encoding: 'utf8',
          env: { PATH: '/usr/bin:/bin' },
        }),
    };
    odroid.script = odroid.makeScript();
    return odroid;
  }

  test('a fresh install copies exactly the report script and the engine, executable, and nothing else', () => {
    const odroid = createOdroid();
    const done = odroid.install();
    expect(done.status).toBe(0);
    expect(readdirSync(odroid.lib).sort()).toEqual(['odroid-stage-qa-report.py', 'stage-smoke.py']);
    for (const name of readdirSync(odroid.lib)) {
      expect(modeOf(join(odroid.lib, name))).toBe(0o755);
      expect(readFileSync(join(odroid.lib, name), 'utf8')).toEndWith('# one\n');
    }
    expect(modeOf(odroid.lib)).toBe(0o755);
    expect(leftovers(join(odroid.lib, '..'))).toEqual([]);
  });

  test('the installed report script runs from the installed layout and refuses anything but the verb', () => {
    const odroid = createOdroid();
    odroid.install();
    const done = spawnSync(join(odroid.lib, 'odroid-stage-qa-report.py'), [], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', SSH_ORIGINAL_COMMAND: 'rm -rf /' },
    });
    expect(done.status).toBe(2);
    expect(done.stderr).toContain("the only accepted command is 'report'");
  });

  test('prints the authorized_keys line, the end to end check and a rollback that restores the previous lib', () => {
    const odroid = createOdroid();
    expect(odroid.install().status).toBe(0);
    odroid.checkout.write('two');
    odroid.checkout.commit('second');
    odroid.checkout.publish();
    const done = odroid.install();
    expect(done.status).toBe(0);
    expect(done.stdout).toContain(
      `restrict,command="${odroid.lib}/odroid-stage-qa-report.py" <public key from scripts/install-stage-qa-pc.sh> esb-stage-qa-pc`,
    );
    expect(done.stdout).toContain('ssh -i ~/.ssh/esb-stage-qa_ed25519 root@<odroid> report');
    expect(readFileSync(join(odroid.lib, 'stage-smoke.py'), 'utf8')).toEndWith('# two\n');
    const rollback = done.stdout.split('\n').find((l) => l.startsWith('rollback: '));
    const run = spawnSync('bash', ['-c', (rollback ?? '').slice('rollback: '.length)], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(readFileSync(join(odroid.lib, 'stage-smoke.py'), 'utf8')).toEndWith('# one\n');
  });

  test('refuses a non-root caller (the unmodified installer wants uid 0)', () => {
    const odroid = createOdroid();
    const unmodified = join(odroid.lib, '..', 'unmodified.sh');
    mkdirSync(join(odroid.lib, '..'), { recursive: true });
    writeExecutable(unmodified, readFileSync(ODROID_INSTALLER, 'utf8'));
    const done = spawnSync(unmodified, [odroid.checkout.src], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(done.status).toBe(2);
    expect(done.stderr).toContain('must run as root');
  });

  test('refuses a host without the service account the report script drops to', () => {
    const odroid = createOdroid();
    odroid.script = odroid.makeScript([
      [
        `readonly SERVICE_USER=${userInfo().username}\n`,
        'readonly SERVICE_USER=no-such-account-xyz\n',
      ],
    ]);
    const done = odroid.install();
    expect(done.status).toBe(2);
    expect(done.stderr).toContain('service account no-such-account-xyz does not exist');
    expect(existsSync(odroid.lib)).toBe(false);
  });

  test('refuses code that is not committed on origin/main', () => {
    const odroid = createOdroid();
    writeFileSync(join(odroid.checkout.src, 'scripts/odroid-stage-qa-report.py'), '# edited\n');
    expect(odroid.install().stderr).toContain('uncommitted or untracked changes');
    odroid.checkout.write('local');
    odroid.checkout.commit('local only');
    expect(odroid.install().stderr).toContain('not on origin/main');
    expect(existsSync(odroid.lib)).toBe(false);
  });

  test('the installer touches only its own lib: no pm2, no checkout, no log is named in it', () => {
    const source = readFileSync(ODROID_INSTALLER, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(source).not.toMatch(/pm2|\.env|logs?\/|rm -rf -- "?\$SRC|\bsystemctl\b/);
  });
});

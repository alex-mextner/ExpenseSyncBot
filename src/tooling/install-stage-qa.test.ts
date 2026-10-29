// scripts/install-stage-qa.sh (odroid, root) and scripts/install-stage-qa-browser.sh (browser host, normal user) are
// run by hand from a reviewed main checkout; the by-hand steps decide what is trusted, so the installers refuse
// anything that is not committed code on origin/main. The tests run the real scripts against a real git
// checkout; only the fixed `readonly` paths and ids at the top are rewritten to point into a temp dir (the
// scripts take no environment overrides, which is what keeps a hostile environment from redirecting them). The
// network toolchain part of the browser installer is played by fake `npm`, `uv`, `apt-get`, `dpkg-deb`, `ldd`
// and `uname` in a temp bin dir that leads the PATH; every fake logs its call to $FAKE_LOG.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
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
import { dirname, join } from 'node:path';
import {
  holdLock,
  PROD_USERNAME,
  REPO,
  REQUIRED_CASES,
  STAGE_USERNAME,
  type TempRoot,
  tempRoot,
  writeExecutable,
} from '../test-utils/stage-qa-fixtures';

setDefaultTimeout(60_000);

const ODROID_INSTALLER = join(REPO, 'scripts/install-stage-qa.sh');
const BROWSER_INSTALLER = join(REPO, 'scripts/install-stage-qa-browser.sh');
const ODROID_SOURCES = [
  'scripts/odroid-stage-qa-report.py',
  'scripts/stage-smoke.py',
  'scripts/stage-qa-driver.py',
  'scripts/stage_qa_common.py',
];
const BROWSER_SOURCES = [
  'scripts/stage-qa-browser.py',
  'scripts/stage_qa_common.py',
  'scripts/stage-smoke.py',
];
const ALL_SOURCES = [...new Set([...ODROID_SOURCES, ...BROWSER_SOURCES])];

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
    // The real scripts (with a version marker) so the installed layout can be executed.
    write: (version) => {
      for (const rel of ALL_SOURCES) {
        writeFileSync(join(src, rel), `${readFileSync(join(REPO, rel), 'utf8')}\n# ${version}\n`);
        chmodSync(join(src, rel), 0o755);
      }
    },
    commit: (message) => {
      git(src, 'add', '-A');
      git(src, 'commit', '-q', '--no-verify', '-m', message);
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

function rollbackOf(stdout: string): string {
  const line = stdout.split('\n').find((l) => l.startsWith('rollback: '));
  if (line === undefined) throw new Error('the installer printed no rollback line');
  return line.slice('rollback: '.length);
}

// npm and uv are String.raw: they are shell, and the `\n` of their printf must reach the shell as two characters.
const FAKE_NPM = String.raw`#!/bin/sh
echo "npm $*" >> "$FAKE_LOG"
[ -z "$FAKE_NPM_FAIL" ] || { echo "npm ERR! fake failure" >&2; exit 1; }
prefix=""
while [ $# -gt 0 ]; do
  if [ "$1" = --prefix ]; then prefix=$2; fi
  shift
done
mkdir -p "$prefix/node_modules/agent-browser/bin"
cat > "$prefix/node_modules/agent-browser/bin/agent-browser-linux-x64" <<'EOT'
#!/bin/sh
echo "agent-browser $*" >> "$FAKE_LOG"
if [ "$1" = install ]; then
  mkdir -p "$HOME/.agent-browser/browsers/chrome-1"
  printf '#!/bin/sh\nexit 0\n' > "$HOME/.agent-browser/browsers/chrome-1/chrome"
  chmod 755 "$HOME/.agent-browser/browsers/chrome-1/chrome"
fi
EOT
chmod 755 "$prefix/node_modules/agent-browser/bin/agent-browser-linux-x64"
`;

const FAKE_UV = String.raw`#!/bin/sh
echo "uv $*" >> "$FAKE_LOG"
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\nexit 0\n' > "$HOME/.local/bin/qa"
chmod 755 "$HOME/.local/bin/qa"
`;

const FAKE_APT_GET = `#!/bin/sh
echo "apt-get $*" >> "$FAKE_LOG"
[ "$1" = download ] || exit 64
shift
for pkg in "$@"; do echo "$pkg" > "$pkg"_1.0_amd64.deb; done
`;

const FAKE_DPKG_DEB = `#!/bin/sh
echo "dpkg-deb $*" >> "$FAKE_LOG"
[ "$1" = -x ] || exit 64
pkg=$(cat "$2")
dest=$3
case "$pkg" in
  fonts-*)
    mkdir -p "$dest/usr/share/fonts/truetype/dejavu"
    : > "$dest/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    ;;
  *)
    mkdir -p "$dest/usr/lib/x86_64-linux-gnu"
    : > "$dest/usr/lib/x86_64-linux-gnu/lib-$pkg.so"
    ;;
esac
`;

// Reports one missing library until libnss3 has been unpacked into a directory of LD_LIBRARY_PATH.
const FAKE_LDD = `#!/bin/sh
echo "ldd $*" >> "$FAKE_LOG"
echo "	libc.so.6 => /lib/libc.so.6 (0x0000)"
found=0
old_ifs=$IFS
IFS=:
for dir in $LD_LIBRARY_PATH; do
  [ -e "$dir/lib-libnss3.so" ] && found=1
done
IFS=$old_ifs
[ "$found" = 1 ] || echo "	libnss3.so => not found"
exit 0
`;

const FAKE_UNAME = `#!/bin/sh
if [ "$1" = -m ]; then echo "uname $*" >> "$FAKE_LOG.uname"; echo x86_64; else exec /bin/uname "$@"; fi
`;

describe('install-stage-qa-browser.sh', () => {
  interface Browser {
    checkout: Checkout;
    home: string;
    bin: string;
    log: string;
    lib: string;
    entry: string;
    config: string;
    toolchain: string;
    lock: string;
    script: string;
    install: (args?: string[], env?: Record<string, string>) => SpawnSyncReturns<string>;
    makeScript: (replacements?: Array<[string, string]>) => string;
    calls: () => string[];
  }

  function createBrowser(): Browser {
    temp = tempRoot('install-stage-qa-browser-');
    const root = temp.dir;
    const home = join(root, 'home');
    const bin = join(root, 'fakes');
    mkdirSync(home);
    for (const [name, text] of [
      ['npm', FAKE_NPM],
      ['uv', FAKE_UV],
      ['apt-get', FAKE_APT_GET],
      ['dpkg-deb', FAKE_DPKG_DEB],
      ['ldd', FAKE_LDD],
      ['uname', FAKE_UNAME],
    ] as const) {
      writeExecutable(join(bin, name), text);
    }
    const log = join(root, 'fake.log');
    const browser: Browser = {
      checkout: createCheckout(root),
      home,
      bin,
      log,
      lib: join(home, 'esb-stage-qa/lib'),
      entry: join(home, 'esb-stage-qa/bin/stage-qa-browser'),
      config: join(home, '.config/esb-stage-qa/browser.json'),
      toolchain: join(home, 'hypercal-stage-qa'),
      lock: join(home, '.local/state/hypercal-stage-qa/qa.lock'),
      script: '',
      makeScript: (replacements = []) => {
        const script = join(root, 'install-stage-qa-browser.sh');
        writeExecutable(
          script,
          rewrite(readFileSync(BROWSER_INSTALLER, 'utf8'), [
            ['readonly BROWSER_LOCK_WAIT=60\n', 'readonly BROWSER_LOCK_WAIT=1\n'],
            ...replacements,
          ]),
        );
        return script;
      },
      install: (args, env = {}) =>
        spawnSync(browser.script, args ?? [browser.checkout.src], {
          encoding: 'utf8',
          // The installer runs with the caller's PATH: the fakes lead it.
          env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, FAKE_LOG: log, ...env },
        }),
      calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
    };
    browser.script = browser.makeScript();
    return browser;
  }

  test('asks the machine architecture once and derives the binary and the library directory from the answer', () => {
    const b = createBrowser();
    expect(b.install().status).toBe(0);
    expect(readFileSync(`${b.log}.uname`, 'utf8').split('\n').filter(Boolean)).toEqual([
      'uname -m',
    ]);
    expect(readFileSync(BROWSER_INSTALLER, 'utf8').match(/uname -m/g)).toHaveLength(1);
  });

  test('a fresh install lays out the lib, the entry and the config, and leaves nothing behind', () => {
    const b = createBrowser();
    const done = b.install();
    expect(done.status).toBe(0);
    expect(readdirSync(b.lib).sort()).toEqual([
      'stage-qa-browser.py',
      'stage-smoke.py',
      'stage_qa_common.py',
    ]);
    for (const name of readdirSync(b.lib)) {
      expect(readFileSync(join(b.lib, name), 'utf8')).toEndWith('# one\n');
      expect(modeOf(join(b.lib, name))).toBe(0o755);
    }
    expect(modeOf(b.entry)).toBe(0o755);
    expect(modeOf(b.config)).toBe(0o600);
    expect(leftovers(join(b.home, 'esb-stage-qa'))).toEqual([]);
    expect(leftovers(join(b.home, '.config/esb-stage-qa'))).toEqual([]);
    expect(leftovers(b.toolchain)).toEqual([]);
  });

  test('the entry sets the browser environment from the shared toolchain and runs the browser half from its own lib', () => {
    const b = createBrowser();
    b.install();
    const entry = readFileSync(b.entry, 'utf8');
    expect(entry).toContain(
      `export QA_BROWSER_BIN=${b.toolchain}/npm/node_modules/agent-browser/bin/agent-browser-linux-x64`,
    );
    expect(entry).toContain('export AGENT_BROWSER_ARGS=--no-sandbox');
    expect(entry).toContain(`export FONTCONFIG_FILE=${b.toolchain}/fonts.conf`);
    expect(entry).toContain(`export TMPDIR=${b.toolchain}/tmp`);
    expect(entry).toContain(
      `export LD_LIBRARY_PATH=${b.toolchain}/chrome-libs/root/usr/lib/x86_64-linux-gnu`,
    );
    expect(entry).toContain(
      `exec python3 ${b.lib}/stage-qa-browser.py "\${SSH_ORIGINAL_COMMAND-}"`,
    );
    expect(modeOf(join(b.toolchain, 'tmp'))).toBe(0o700);
  });

  test('installs the toolchain once, with the pinned versions, into the directories the HyperCalendarBot half shares', () => {
    const b = createBrowser();
    expect(b.install().status).toBe(0);
    const calls = b.calls();
    expect(calls).toContain(
      `npm install --prefix ${b.toolchain}/npm --no-audit --no-fund agent-browser@0.39.1`,
    );
    expect(calls.some((c) => c.startsWith('uv tool install --force --python python3 '))).toBe(true);
    expect(
      calls.some((c) =>
        c.includes(
          'git+https://git.hyperide.ai/ultrabricks/qa-cli@875b11a0f3965de54e2015d525720008d8926f2f',
        ),
      ),
    ).toBe(true);
    expect(calls.some((c) => c.startsWith('apt-get download libnspr4 libnss3'))).toBe(true);
    expect(existsSync(join(b.toolchain, 'fonts.conf'))).toBe(true);
    expect(existsSync(join(b.home, '.local/bin/qa'))).toBe(true);
    expect(modeOf(join(b.toolchain, 'tmp'))).toBe(0o700);
  });

  test('an existing toolchain and an existing HyperCalendarBot browser half are used and left alone', () => {
    const b = createBrowser();
    expect(b.install().status).toBe(0);
    const hcbLib = join(b.toolchain, 'lib');
    const hcbBin = join(b.toolchain, 'bin');
    mkdirSync(hcbLib, { recursive: true });
    mkdirSync(hcbBin, { recursive: true });
    writeFileSync(join(hcbLib, 'stage-qa-browser.py'), '# the other repository\n');
    writeFileSync(join(hcbBin, 'stage-qa-browser'), '#!/bin/sh\n# the other repository\n');
    const fontsBefore = readFileSync(join(b.toolchain, 'fonts.conf'), 'utf8');
    writeFileSync(b.log, '');
    b.checkout.write('two');
    b.checkout.commit('second');
    b.checkout.publish();
    expect(b.install().status).toBe(0);
    // Nothing is fetched or unpacked again.
    expect(b.calls().filter((c) => /^(npm|uv|apt-get|dpkg-deb)\b/.test(c))).toEqual([]);
    expect(readFileSync(join(b.toolchain, 'fonts.conf'), 'utf8')).toBe(fontsBefore);
    expect(readFileSync(join(hcbLib, 'stage-qa-browser.py'), 'utf8')).toBe(
      '# the other repository\n',
    );
    expect(readFileSync(join(hcbBin, 'stage-qa-browser'), 'utf8')).toBe(
      '#!/bin/sh\n# the other repository\n',
    );
    expect(readFileSync(join(b.lib, 'stage-qa-browser.py'), 'utf8')).toEndWith('# two\n');
  });

  test('the config it writes is accepted by the browser half it installs, with the floor of the case list', () => {
    const b = createBrowser();
    b.install();
    const check = spawnSync(
      'python3',
      [
        '-c',
        `
import importlib.util, sys
sys.path.insert(0, sys.argv[1])
spec = importlib.util.spec_from_file_location("browser", sys.argv[1] + "/stage-qa-browser.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
config = module.load_config(sys.argv[2])
print(config.username, config.deny_usernames, config.min_cases, list(config.required_cases), config.lock_file.endswith("hypercal-stage-qa/qa.lock"), config.state_dir.endswith("esb-stage-qa"))
`,
        b.lib,
        b.config,
      ],
      { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: b.home } },
    );
    expect(check.stderr).toBe('');
    expect(check.stdout.trim()).toBe(
      `${STAGE_USERNAME} ('${PROD_USERNAME}',) 5 ${JSON.stringify(REQUIRED_CASES).replaceAll('"', "'").replaceAll(',', ', ')} True True`,
    );
  });

  test('the installed entry runs the browser half from the installed layout (it finds its engine and common module)', () => {
    const b = createBrowser();
    b.install();
    const done = spawnSync(b.entry, [], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: b.home, SSH_ORIGINAL_COMMAND: 'not-a-sha' },
    });
    expect(done.status).toBe(2);
    expect(done.stdout).toBe('STAGE_QA_RESULT status=refused sha=- cases=0 failed=0\n');
  });

  test('prints the authorized_keys line for the odroid key and the rollback, never a private key', () => {
    const b = createBrowser();
    const done = b.install();
    expect(done.stdout).toContain(
      `restrict,command="${b.entry}" ssh-ed25519 AAAA... esb-stage-qa-odroid\n`,
    );
    expect(done.stdout).toContain('/var/lib/hcb-qa-runner/.ssh/esb-stage-browser_ed25519');
    expect(done.stdout).toMatch(/^rollback: .+/m);
    expect(done.stdout + done.stderr).not.toContain('PRIVATE KEY');
  });

  test('a reinstall keeps the edited config, backs the lib and the entry up, and the printed rollback restores them', () => {
    const b = createBrowser();
    expect(b.install().status).toBe(0);
    writeFileSync(b.config, '{"edited": true}\n');
    const entryBefore = readFileSync(b.entry, 'utf8');
    b.checkout.write('two');
    b.checkout.commit('second');
    b.checkout.publish();
    const done = b.install();
    expect(done.status).toBe(0);
    expect(readFileSync(b.config, 'utf8')).toBe('{"edited": true}\n');
    expect(readFileSync(join(b.lib, 'stage-qa-browser.py'), 'utf8')).toEndWith('# two\n');
    const backups = readdirSync(join(b.home, 'esb-stage-qa')).filter((n) => n.includes('.bak-'));
    expect(backups.length).toBe(1);
    expect(
      readdirSync(join(b.home, 'esb-stage-qa/bin')).filter((n) => n.includes('.bak-')).length,
    ).toBe(1);
    writeFileSync(b.entry, '# replaced\n');
    const run = spawnSync('bash', ['-c', rollbackOf(done.stdout)], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(readFileSync(join(b.lib, 'stage-qa-browser.py'), 'utf8')).toEndWith('# one\n');
    expect(readFileSync(b.entry, 'utf8')).toBe(entryBefore);
  });

  test('refuses uncommitted changes, untracked listed files, and a HEAD that is not on origin/main', () => {
    const b = createBrowser();
    writeFileSync(join(b.checkout.src, 'scripts/stage-smoke.py'), '# edited\n');
    let done = b.install();
    expect(done.status).toBe(2);
    expect(done.stderr).toContain('uncommitted or untracked changes');
    expect(existsSync(b.lib)).toBe(false);
    b.checkout.write('local');
    b.checkout.commit('local only');
    done = b.install();
    expect(done.status).toBe(2);
    expect(done.stderr).toContain('not on origin/main');
    expect(existsSync(b.lib)).toBe(false);
    expect(b.calls()).toEqual([]);
  });

  test('refuses a checkout that is not a git checkout, one without a listed file, and extra arguments', () => {
    const b = createBrowser();
    const plain = join(b.home, 'plain');
    mkdirSync(join(plain, 'scripts'), { recursive: true });
    for (const rel of BROWSER_SOURCES) copyFileSync(join(REPO, rel), join(plain, rel));
    expect(b.install([plain]).stderr).toContain('not a git checkout');
    const empty = join(b.home, 'empty');
    mkdirSync(empty);
    expect(b.install([empty]).stderr).toContain('unknown checkout layout');
    expect(b.install([b.checkout.src, 'x']).stderr).toContain('usage:');
    expect(existsSync(b.lib)).toBe(false);
  });

  test('refuses root', () => {
    const b = createBrowser();
    b.script = b.makeScript([
      ['readonly FORBIDDEN_EUID=0\n', `readonly FORBIDDEN_EUID=${userInfo().uid}\n`],
    ]);
    const done = b.install();
    expect(done.status).toBe(2);
    expect(done.stderr).toContain('not root');
  });

  test('a failing toolchain step fails the install with nothing laid out', () => {
    const b = createBrowser();
    const done = b.install(undefined, { FAKE_NPM_FAIL: '1' });
    expect(done.status).toBe(2);
    expect(done.stderr).toContain('npm install of agent-browser failed');
    expect(existsSync(b.lib)).toBe(false);
    expect(existsSync(b.entry)).toBe(false);
    expect(existsSync(b.config)).toBe(false);
  });

  test('the newest Chrome by version is the one the libraries are checked for (chrome-10 beats chrome-9)', () => {
    const b = createBrowser();
    expect(b.install().status).toBe(0);
    const browsers = join(b.home, '.agent-browser/browsers');
    for (const name of ['chrome-9', 'chrome-10']) {
      writeExecutable(join(browsers, name, 'chrome'), '#!/bin/sh\nexit 0\n');
    }
    writeFileSync(b.log, '');
    b.checkout.write('two');
    b.checkout.commit('second');
    b.checkout.publish();
    expect(b.install().status).toBe(0);
    const checks = b.calls().filter((call) => call.startsWith('ldd '));
    expect(checks.length).toBeGreaterThan(0);
    for (const call of checks) expect(call).toContain('chrome-10/chrome');
  });

  test('a directory that already exists keeps its mode: the lock and toolchain directories are shared with the other repository', () => {
    const b = createBrowser();
    const stateDir = dirname(b.lock);
    mkdirSync(stateDir, { recursive: true });
    chmodSync(stateDir, 0o755);
    expect(b.install().status).toBe(0);
    expect(modeOf(stateDir)).toBe(0o755);
  });

  test('waits for a QA run that holds the browser lock, gives up with 75 and changes nothing', async () => {
    const b = createBrowser();
    const holder = holdLock(b.lock);
    try {
      await holder.ready;
      const done = b.install();
      expect(done.status).toBe(75);
      expect(done.stderr).toContain('holds');
      expect(existsSync(b.lib)).toBe(false);
      expect(existsSync(b.config)).toBe(false);
      expect(b.calls()).toEqual([]);
    } finally {
      holder.stop();
    }
  });
});

describe('install-stage-qa.sh', () => {
  interface Odroid {
    checkout: Checkout;
    lib: string;
    config: string;
    script: string;
    install: (...args: string[]) => SpawnSyncReturns<string>;
    makeScript: (replacements?: Array<[string, string]>) => string;
  }

  function createOdroid(): Odroid {
    temp = tempRoot('install-stage-qa-');
    const root = temp.dir;
    const lib = join(root, 'usr/local/lib/esb-stage-qa');
    const config = join(root, 'etc/esb-stage-qa/driver.json');
    const { uid, gid, username } = userInfo();
    const odroid: Odroid = {
      checkout: createCheckout(root),
      lib,
      config,
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
            [
              'readonly DRIVER_CONFIG=/etc/esb-stage-qa/driver.json\n',
              `readonly DRIVER_CONFIG=${config}\n`,
            ],
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

  test('a fresh install copies exactly the report script, the engine, the driver and its common module, executable', () => {
    const odroid = createOdroid();
    const done = odroid.install();
    expect(done.status).toBe(0);
    expect(readdirSync(odroid.lib).sort()).toEqual([
      'odroid-stage-qa-report.py',
      'stage-qa-driver.py',
      'stage-smoke.py',
      'stage_qa_common.py',
    ]);
    for (const name of readdirSync(odroid.lib)) {
      expect(modeOf(join(odroid.lib, name))).toBe(0o755);
      expect(readFileSync(join(odroid.lib, name), 'utf8')).toEndWith('# one\n');
    }
    expect(modeOf(odroid.lib)).toBe(0o755);
    expect(leftovers(join(odroid.lib, '..'))).toEqual([]);
  });

  test('creates the driver config once, with the browser host, the ESB key and known_hosts, and never overwrites it', () => {
    const odroid = createOdroid();
    expect(odroid.install().status).toBe(0);
    expect(JSON.parse(readFileSync(odroid.config, 'utf8'))).toEqual({
      browser_target: 'ultra@65.21.40.51',
      browser_key: '/var/lib/hcb-qa-runner/.ssh/esb-stage-browser_ed25519',
      browser_known_hosts: '/var/lib/hcb-qa-runner/.ssh/known_hosts',
    });
    expect(modeOf(odroid.config)).toBe(0o644);
    writeFileSync(odroid.config, '{"edited": true}\n');
    odroid.checkout.write('two');
    odroid.checkout.commit('second');
    odroid.checkout.publish();
    const second = odroid.install();
    expect(second.status).toBe(0);
    expect(second.stdout).not.toContain('created');
    expect(readFileSync(odroid.config, 'utf8')).toBe('{"edited": true}\n');
    expect(leftovers(join(odroid.config, '..'))).toEqual([]);
  });

  test('the installed driver runs from the installed layout (it finds its common module) and takes its config from the installer', () => {
    const odroid = createOdroid();
    odroid.install();
    const refused = spawnSync(join(odroid.lib, 'stage-qa-driver.py'), ['not-a-sha'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(refused.status).toBe(2);
    expect(refused.stdout).toBe('STAGE_QA_RESULT status=refused sha=- cases=0 failed=0\n');
    // The config the installer wrote is one the driver accepts: only the missing ssh key is wrong here.
    const sha = 'a'.repeat(40);
    const loaded = spawnSync(
      join(odroid.lib, 'stage-qa-driver.py'),
      [sha, '--config', odroid.config],
      {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin' },
      },
    );
    expect(loaded.status).toBe(3);
    expect(loaded.stderr).toContain(
      'ssh key /var/lib/hcb-qa-runner/.ssh/esb-stage-browser_ed25519 not found',
    );
  });

  test('the installed report script runs from the installed layout and reports nothing without a stage slot', () => {
    const odroid = createOdroid();
    odroid.install();
    const done = spawnSync(join(odroid.lib, 'odroid-stage-qa-report.py'), ['--bogus'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(done.status).toBe(2);
    expect(done.stdout).toBe('');
  });

  test('prints the sudoers line for the runner user, the end to end check and a rollback that restores the previous lib', () => {
    const odroid = createOdroid();
    expect(odroid.install().status).toBe(0);
    odroid.checkout.write('two');
    odroid.checkout.commit('second');
    odroid.checkout.publish();
    const done = odroid.install();
    expect(done.status).toBe(0);
    expect(done.stdout).toContain(
      `hcb-qa ALL=(root) NOPASSWD: ${odroid.lib}/odroid-stage-qa-report.py ""\n`,
    );
    expect(done.stdout).toContain(`sudo -u hcb-qa sudo -n ${odroid.lib}/odroid-stage-qa-report.py`);
    expect(done.stdout).not.toContain('authorized_keys');
    expect(readFileSync(join(odroid.lib, 'stage-smoke.py'), 'utf8')).toEndWith('# two\n');
    const run = spawnSync('bash', ['-c', rollbackOf(done.stdout)], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(readFileSync(join(odroid.lib, 'stage-smoke.py'), 'utf8')).toEndWith('# one\n');
  });

  test('the rollback of a first install removes the lib and the config it created', () => {
    const odroid = createOdroid();
    const done = odroid.install();
    expect(done.status).toBe(0);
    const run = spawnSync('bash', ['-c', rollbackOf(done.stdout)], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(existsSync(odroid.lib)).toBe(false);
    expect(existsSync(odroid.config)).toBe(false);
  });

  test('a failed install removes the driver config it just created and leaves no half-installed lib', () => {
    const odroid = createOdroid();
    // `mv -T` is the swap of the new lib into place (a first install has no backup move); it fails here,
    // after the config was created. The fake leads the installer's fixed PATH.
    const fakes = join(dirname(odroid.script), 'fakes');
    writeExecutable(
      join(fakes, 'mv'),
      `#!/bin/sh\ncase " $* " in *" -T "*) echo 'mv: injected failure' >&2; exit 1 ;; esac\nexec /bin/mv "$@"\n`,
    );
    odroid.script = odroid.makeScript([['readonly SAFE_PATH=', `readonly SAFE_PATH=${fakes}:`]]);
    const done = odroid.install();
    expect(done.status).not.toBe(0);
    expect(done.stderr).toContain('injected failure');
    expect(existsSync(odroid.config)).toBe(false);
    expect(existsSync(odroid.lib)).toBe(false);
    expect(leftovers(join(odroid.lib, '..'))).toEqual([]);
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
    writeFileSync(join(odroid.checkout.src, 'scripts/stage-qa-driver.py'), '# edited\n');
    expect(odroid.install().stderr).toContain('uncommitted or untracked changes');
    odroid.checkout.write('local');
    odroid.checkout.commit('local only');
    expect(odroid.install().stderr).toContain('not on origin/main');
    expect(existsSync(odroid.lib)).toBe(false);
    expect(existsSync(odroid.config)).toBe(false);
  });

  test('the installer touches only its own lib and config: no pm2, no checkout, no log, no sudoers file is written', () => {
    const source = readFileSync(ODROID_INSTALLER, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#') && !line.includes('printf'))
      .join('\n');
    expect(source).not.toMatch(/pm2|\.env|logs?\/|rm -rf -- "?\$SRC|\bsystemctl\b|sudoers|visudo/);
  });
});

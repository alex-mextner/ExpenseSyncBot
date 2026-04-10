// Parallel test runner — each file in its own bun process for mock isolation

import { cpus } from 'node:os';
const CONCURRENCY = Number(process.env['TEST_CONCURRENCY']) || cpus().length;
const FILTER = process.argv[2] ?? '';

interface FileResult {
  file: string;
  pass: number;
  fail: number;
  duration: number;
  ok: boolean;
  output: string;
}

async function findTestFiles(): Promise<string[]> {
  const glob = new Bun.Glob('src/**/*.test.ts');
  const files: string[] = [];
  for await (const path of glob.scan({ cwd: '.', onlyFiles: true })) {
    if (path.includes('ZenPlugins')) continue;
    if (FILTER && !path.includes(FILTER)) continue;
    files.push(path);
  }
  return files.sort();
}

let fileCounter = 0;

async function runFile(file: string): Promise<FileResult> {
  // Each test file gets its own SQLite DB to prevent SQLITE_BUSY_RECOVERY
  // when 14+ processes fight over the same database file.
  const dbPath = `/tmp/esb-test-${process.pid}-${fileCounter++}.db`;
  const start = performance.now();
  const proc = Bun.spawn(['bun', 'test', file], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NODE_ENV: 'test', FORCE_COLOR: '1', DATABASE_PATH: dbPath },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  const duration = performance.now() - start;

  // Cleanup temp DB files
  try {
    const fs = await import('node:fs/promises');
    await fs.unlink(dbPath).catch(() => {});
    await fs.unlink(`${dbPath}-wal`).catch(() => {});
    await fs.unlink(`${dbPath}-shm`).catch(() => {});
  } catch {
    // best-effort cleanup
  }

  const rawOutput = stdout + stderr;
  // Strip ANSI escape codes before parsing — FORCE_COLOR produces them
  const clean = rawOutput.replace(/\x1b\[[0-9;]*m/g, '');

  // Parse bun test output: " N pass" and " N fail"
  const passMatch = clean.match(/(\d+)\s+pass/);
  const failMatch = clean.match(/(\d+)\s+fail/);

  return {
    file,
    pass: passMatch ? Number(passMatch[1]) : 0,
    fail: failMatch ? Number(failMatch[1]) : 0,
    duration,
    ok: exitCode === 0,
    output: rawOutput,
  };
}

async function run(): Promise<void> {
  const files = await findTestFiles();
  if (files.length === 0) {
    console.log('No test files found.');
    process.exit(0);
  }

  console.log(`Running ${files.length} test files (concurrency: ${CONCURRENCY}, CPUs: ${cpus().length})\n`);
  const start = performance.now();

  const results = await runPool(files, CONCURRENCY);

  const totalDuration = performance.now() - start;
  const totalPass = results.reduce((s, r) => s + r.pass, 0);
  const totalFail = results.reduce((s, r) => s + r.fail, 0);
  const failedFiles = results.filter((r) => !r.ok);

  console.log('\n' + '─'.repeat(60));
  console.log(`Files:  ${results.length} total, ${results.length - failedFiles.length} passed, ${failedFiles.length} failed`);
  console.log(`Tests:  ${totalPass + totalFail} total, ${totalPass} passed, ${totalFail} failed`);
  console.log(`Time:   ${(totalDuration / 1000).toFixed(2)}s`);

  if (failedFiles.length > 0) {
    console.log('\nFailed files:');
    for (const f of failedFiles) {
      console.log(`  \x1b[31m✗\x1b[0m ${f.file}`);
    }
    process.exit(1);
  }
}

async function runPool(files: string[], concurrency: number): Promise<FileResult[]> {
  const results: FileResult[] = [];
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < files.length) {
      const file = files[idx++]!;
      const result = await runFile(file);
      results.push(result);
      const icon = result.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      const ms = `${Math.round(result.duration)}ms`;
      console.log(`  ${icon} ${result.file} (${result.pass} pass, ${result.fail} fail) [${ms}]`);
      if (!result.ok) {
        console.log(result.output.split('\n').map((l) => `    ${l}`).join('\n'));
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

run();

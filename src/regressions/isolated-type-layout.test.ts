// Regression guard for tsconfig.json under Bun's global store (globalStore = true).
// There every package's real path lives in ~/.bun/install/cache/links, outside the
// checkout, so TypeScript can no longer walk up from a stored package to this project.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const repoRoot = resolve(import.meta.dir, '../..');

/** Parse this repo's tsconfig.json as if it lived in `project` (relative paths resolve there). */
function compilerOptionsFor(project: string): ts.CompilerOptions {
  const config = ts.readConfigFile(join(repoRoot, 'tsconfig.json'), ts.sys.readFile);
  expect(config.error).toBeUndefined();
  return ts.parseJsonConfigFileContent(config.config, ts.sys, project).options;
}

function writePackage(dir: string, name: string, dts: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.d.ts'), dts);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, types: 'index.d.ts' }));
}

function createProgram(project: string, entry: string, options: ts.CompilerOptions): ts.Program {
  const host = ts.createCompilerHost(options);
  host.getCurrentDirectory = () => project;
  return ts.createProgram([entry], options, host);
}

describe('tsconfig type resolution with the Bun global store', () => {
  test('an undeclared undici-types import from a stored package resolves through the hoist directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'esb-global-store-'));
    try {
      // Like bun-types: a stored package that imports undici-types without declaring it.
      const project = join(dir, 'project');
      const stored = join(dir, 'store/proof-types@1.0.0-hash/node_modules/@types/proof');
      writePackage(
        stored,
        '@types/proof',
        'declare global { var probe: import("undici-types").Probe; }\nexport {};\n',
      );
      writePackage(
        join(project, 'node_modules/.bun/node_modules/undici-types'),
        'undici-types',
        'export interface Probe { ok: boolean }\n',
      );
      mkdirSync(join(project, 'node_modules/@types'), { recursive: true });
      symlinkSync(stored, join(project, 'node_modules/@types/proof'), 'dir');
      const entry = join(project, 'entry.ts');
      writeFileSync(entry, 'const ok = probe.ok;\nexport { ok };\n');

      const program = createProgram(project, entry, {
        ...compilerOptionsFor(project),
        types: ['proof'],
      });
      const errors = ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      expect(errors).toEqual([]);
      const source = program.getSourceFile(entry);
      if (!source) throw new Error('entry.ts is not in the program');
      const statement = source.statements.find(ts.isVariableStatement);
      if (!statement) throw new Error('entry.ts has no variable statement');
      const declaration = statement.declarationList.declarations[0];
      if (!declaration) throw new Error('entry.ts declares nothing');
      const type = program.getTypeChecker().getTypeAtLocation(declaration.name);
      expect(type.flags & ts.TypeFlags.Any).toBe(0);
      expect(type.flags & ts.TypeFlags.BooleanLike).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a worktree nested in another checkout loads only its own @types', () => {
    const dir = mkdtempSync(join(tmpdir(), 'esb-nested-worktree-'));
    try {
      // The main checkout's node_modules/@types sits above a worktree in .worktrees/.
      writePackage(
        join(dir, 'node_modules/@types/stale'),
        '@types/stale',
        'declare var staleGlobal: string;\n',
      );
      const project = join(dir, '.worktrees/feature');
      mkdirSync(join(project, 'node_modules/@types'), { recursive: true });
      const entry = join(project, 'entry.ts');
      writeFileSync(entry, 'export const answer = 42;\n');

      const program = createProgram(project, entry, compilerOptionsFor(project));
      const loaded = program.getSourceFiles().map((file) => file.fileName);
      expect(loaded.some((name) => name.includes('@types/stale'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

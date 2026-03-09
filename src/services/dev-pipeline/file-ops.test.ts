import { test, expect, describe } from 'bun:test';
import { validateFilePath } from './file-ops';

const WORKTREE = '/tmp/fake-worktree';

describe('validateFilePath', () => {
  // --- Protected paths that must throw ---

  describe('protected files/directories', () => {
    test('rejects pipeline code (src/services/dev-pipeline/)', () => {
      expect(() =>
        validateFilePath(WORKTREE, 'src/services/dev-pipeline/pipeline.ts')
      ).toThrow('Cannot modify protected file/directory');
    });

    test('rejects database schema', () => {
      expect(() =>
        validateFilePath(WORKTREE, 'src/database/schema.ts')
      ).toThrow('Cannot modify protected file/directory');
    });

    test('rejects CI config (.github/workflows/deploy.yml)', () => {
      expect(() =>
        validateFilePath(WORKTREE, '.github/workflows/deploy.yml')
      ).toThrow('Cannot modify protected file/directory');
    });

    test('rejects any file inside .github/', () => {
      expect(() =>
        validateFilePath(WORKTREE, '.github/CODEOWNERS')
      ).toThrow('Cannot modify protected file/directory');
    });
  });

  // --- Valid paths that must NOT throw ---

  describe('allowed paths', () => {
    test('allows regular bot command files', () => {
      const result = validateFilePath(WORKTREE, 'src/bot/commands/ask.ts');
      expect(result).toBe(`${WORKTREE}/src/bot/commands/ask.ts`);
    });

    test('allows service files outside dev-pipeline', () => {
      const result = validateFilePath(
        WORKTREE,
        'src/services/currency/parser.ts'
      );
      expect(result).toBe(`${WORKTREE}/src/services/currency/parser.ts`);
    });
  });

  // --- Path traversal attacks ---

  describe('path traversal protection', () => {
    test('rejects ../../../etc/passwd', () => {
      expect(() =>
        validateFilePath(WORKTREE, '../../../etc/passwd')
      ).toThrow('Path traversal detected');
    });

    test('rejects sneaky traversal to protected dir (src/../.github/...)', () => {
      // path.normalize strips the .., but the result still hits .github/ protection
      expect(() =>
        validateFilePath(WORKTREE, 'src/../.github/workflows/deploy.yml')
      ).toThrow('Cannot modify protected file/directory');
    });
  });

  // --- Edge cases ---

  describe('edge cases', () => {
    test('allows current directory marker (.)', () => {
      const result = validateFilePath(WORKTREE, '.');
      expect(result).toBe(WORKTREE);
    });

    test('handles paths with redundant slashes', () => {
      const result = validateFilePath(
        WORKTREE,
        'src///bot///commands///ask.ts'
      );
      expect(result).toBe(`${WORKTREE}/src/bot/commands/ask.ts`);
    });
  });
});

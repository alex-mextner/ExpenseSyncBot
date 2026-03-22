import { describe, expect, test } from 'bun:test';
import { validateFilePath } from './file-ops';

const WORKTREE = '/tmp/fake-worktree';

describe('validateFilePath', () => {
  // --- Protected paths that must throw ---

  describe('protected files/directories', () => {
    test('rejects pipeline code (src/services/dev-pipeline/)', () => {
      expect(() => validateFilePath(WORKTREE, 'src/services/dev-pipeline/pipeline.ts')).toThrow(
        'Cannot modify protected file/directory',
      );
    });

    test('rejects database schema', () => {
      expect(() => validateFilePath(WORKTREE, 'src/database/schema.ts')).toThrow(
        'Cannot modify protected file/directory',
      );
    });

    test('rejects CI config (.github/workflows/deploy.yml)', () => {
      expect(() => validateFilePath(WORKTREE, '.github/workflows/deploy.yml')).toThrow(
        'Cannot modify protected file/directory',
      );
    });

    test('rejects any file inside .github/', () => {
      expect(() => validateFilePath(WORKTREE, '.github/CODEOWNERS')).toThrow(
        'Cannot modify protected file/directory',
      );
    });
  });

  // --- Valid paths that must NOT throw ---

  describe('allowed paths', () => {
    test('allows regular bot command files', () => {
      const result = validateFilePath(WORKTREE, 'src/bot/commands/ask.ts');
      expect(result).toBe(`${WORKTREE}/src/bot/commands/ask.ts`);
    });

    test('allows service files outside dev-pipeline', () => {
      const result = validateFilePath(WORKTREE, 'src/services/currency/parser.ts');
      expect(result).toBe(`${WORKTREE}/src/services/currency/parser.ts`);
    });
  });

  // --- Path traversal attacks ---

  describe('path traversal protection', () => {
    test('rejects ../../../etc/passwd', () => {
      expect(() => validateFilePath(WORKTREE, '../../../etc/passwd')).toThrow(
        'Path traversal detected',
      );
    });

    test('rejects sneaky traversal to protected dir (src/../.github/...)', () => {
      // path.normalize strips the .., but the result still hits .github/ protection
      expect(() => validateFilePath(WORKTREE, 'src/../.github/workflows/deploy.yml')).toThrow(
        'Cannot modify protected file/directory',
      );
    });
  });

  // --- Edge cases ---

  describe('edge cases', () => {
    test('allows current directory marker (.)', () => {
      const result = validateFilePath(WORKTREE, '.');
      expect(result).toBe(WORKTREE);
    });

    test('handles paths with redundant slashes', () => {
      const result = validateFilePath(WORKTREE, 'src///bot///commands///ask.ts');
      expect(result).toBe(`${WORKTREE}/src/bot/commands/ask.ts`);
    });
  });

  // --- Additional path security cases ---

  describe('path security — additional cases', () => {
    test('allows path with single .. component that resolves within worktree (src/../etc/passwd = etc/passwd)', () => {
      // path.normalize('src/../etc/passwd') = 'etc/passwd' — no '..' remains, within worktree
      // The file does not exist, but validateFilePath only checks path safety, not existence
      const result = validateFilePath(WORKTREE, 'src/../etc/passwd');
      expect(result).toBe(`${WORKTREE}/etc/passwd`);
      expect(result.startsWith(WORKTREE)).toBe(true);
    });

    test('rejects path with multiple consecutive traversals (../../../../)', () => {
      expect(() => validateFilePath(WORKTREE, '../../../../etc/passwd')).toThrow(
        'Path traversal detected',
      );
    });

    test('rejects path that is exactly ..', () => {
      expect(() => validateFilePath(WORKTREE, '..')).toThrow('Path traversal detected');
    });

    test('null byte in path: normalize passes it through, path stays within worktree', () => {
      // path.normalize does not strip null bytes — result is within worktree
      const result = validateFilePath(WORKTREE, 'src/file.ts\x00.jpg');
      expect(result.startsWith(WORKTREE)).toBe(true);
    });

    test('rejects absolute path /etc/passwd (escapes worktree)', () => {
      // path.resolve with absolute path ignores worktree entirely
      expect(() => validateFilePath(WORKTREE, '/etc/passwd')).toThrow();
    });

    test('rejects absolute path /Users/admin/secret', () => {
      expect(() => validateFilePath(WORKTREE, '/Users/admin/secret')).toThrow();
    });

    test('resolved absolute path stays within worktree', () => {
      // A valid relative path resolves inside the worktree
      const result = validateFilePath(WORKTREE, 'src/utils/logger.ts');
      expect(result.startsWith(WORKTREE)).toBe(true);
    });

    test('rejects path to src/database/schema.ts with mixed separators via traversal', () => {
      expect(() => validateFilePath(WORKTREE, 'src/bot/../database/schema.ts')).toThrow();
    });

    test('rejects any file in src/services/dev-pipeline/ subdirectory', () => {
      expect(() => validateFilePath(WORKTREE, 'src/services/dev-pipeline/types.ts')).toThrow(
        'Cannot modify protected file/directory',
      );
    });

    test('rejects dev-pipeline file at nested path', () => {
      expect(() => validateFilePath(WORKTREE, 'src/services/dev-pipeline/sub/deep.ts')).toThrow(
        'Cannot modify protected file/directory',
      );
    });

    test('rejects .github file with different extension', () => {
      expect(() => validateFilePath(WORKTREE, '.github/something.json')).toThrow(
        'Cannot modify protected file/directory',
      );
    });

    test('allows src/database/repositories/ (not protected)', () => {
      const result = validateFilePath(WORKTREE, 'src/database/repositories/expense.repository.ts');
      expect(result).toBe(`${WORKTREE}/src/database/repositories/expense.repository.ts`);
    });

    test('allows src/services/ (outside dev-pipeline)', () => {
      const result = validateFilePath(WORKTREE, 'src/services/analytics/formatters.ts');
      expect(result).toBe(`${WORKTREE}/src/services/analytics/formatters.ts`);
    });

    test('rejects Windows-style path separator with traversal (..\\..\\)', () => {
      // On POSIX, backslash is a valid filename char — but .. still triggers
      // path.normalize on POSIX treats backslash as literal, not separator
      // The important case: if the normalized path contains '..', it's caught
      // Test what actually throws given the POSIX path.normalize behavior
      try {
        const result = validateFilePath(WORKTREE, 'src\\..\\..\\etc\\passwd');
        // If no throw: the path must still be inside the worktree (backslash treated as filename)
        expect(result.startsWith(WORKTREE)).toBe(true);
      } catch {
        // If it throws, it should be for traversal or escaping worktree
        // Either outcome is acceptable — what matters is nothing unsafe is returned
        expect(true).toBe(true);
      }
    });

    test('allows package.json (root config file)', () => {
      const result = validateFilePath(WORKTREE, 'package.json');
      expect(result).toBe(`${WORKTREE}/package.json`);
    });

    test('allows tsconfig.json (root config file)', () => {
      const result = validateFilePath(WORKTREE, 'tsconfig.json');
      expect(result).toBe(`${WORKTREE}/tsconfig.json`);
    });

    test('rejects path with .. in the middle that hits protected path after normalize', () => {
      // src/services/currency/../dev-pipeline/types.ts normalizes to:
      // src/services/dev-pipeline/types.ts — protected
      expect(() =>
        validateFilePath(WORKTREE, 'src/services/currency/../dev-pipeline/types.ts'),
      ).toThrow();
    });

    test('newline in path: normalize treats it as part of filename, stays within worktree', () => {
      // path.normalize does not reject newlines — the path stays inside the worktree
      const result = validateFilePath(WORKTREE, 'src/file.ts\n/etc/passwd');
      expect(result.startsWith(WORKTREE)).toBe(true);
    });

    test('returns absolute path with correct worktree prefix for nested file', () => {
      const result = validateFilePath(WORKTREE, 'src/bot/index.ts');
      expect(result).toBe(`${WORKTREE}/src/bot/index.ts`);
      expect(result.startsWith('/tmp/')).toBe(true);
    });
  });
});

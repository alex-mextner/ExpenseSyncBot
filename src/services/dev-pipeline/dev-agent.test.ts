// Tests for DevAgent — tool-calling loop, tool execution, abort handling.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { StreamRoundResult, StreamToolCall } from '../ai/streaming';

// ─── Mocks ──────────────────────────────────────────────────────────────
const logMock = createMockLogger();

mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

const mockAiStreamRound =
  mock<(opts: import('../ai/streaming').StreamRoundOptions) => Promise<StreamRoundResult>>();

mock.module('../ai/streaming', () => ({
  aiStreamRound: mockAiStreamRound,
}));

// file-ops — stub every export DevAgent uses
const mockReadFile = mock<(wt: string, p: string) => Promise<string>>(async () => 'file body');
const mockWriteFile = mock<(wt: string, p: string, c: string) => Promise<void>>(async () => {});
const mockListDirectory = mock<(wt: string, p: string) => Promise<string[]>>(async () => [
  'a.ts',
  'b.ts',
]);
const mockSearchCode = mock<(wt: string, pat: string, glob?: string) => Promise<string>>(
  async () => 'src/x.ts:1:hit',
);
const mockFileExists = mock<(wt: string, p: string) => boolean>(() => true);
const mockDeleteFile = mock<(wt: string, p: string) => Promise<void>>(async () => {});

mock.module('./file-ops', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  listDirectory: mockListDirectory,
  searchCode: mockSearchCode,
  fileExists: mockFileExists,
  deleteFile: mockDeleteFile,
}));

// git-ops — only the three DevAgent imports
const mockCommitChanges = mock<(wt: string, m: string) => Promise<void>>(async () => {});
const mockManagePackages = mock<(wt: string, a: 'add' | 'remove', pkgs: string) => Promise<string>>(
  async () => 'installed',
);
const mockRevertFileToMain = mock<(wt: string, p: string) => Promise<void>>(async () => {});

mock.module('./git-ops', () => ({
  commitChanges: mockCommitChanges,
  managePackages: mockManagePackages,
  revertFileToMain: mockRevertFileToMain,
}));

// Dynamic import AFTER mocks
const { DevAgent, AgentAbortedError } = await import('./dev-agent');

function textResult(text: string): StreamRoundResult {
  return {
    text,
    toolCalls: [],
    finishReason: 'stop',
    assistantMessage: { role: 'assistant', content: text },
    providerUsed: 'mock',
  };
}

function toolResult(calls: StreamToolCall[], text = ''): StreamRoundResult {
  return {
    text,
    toolCalls: calls,
    finishReason: 'tool_calls',
    assistantMessage: { role: 'assistant', content: text || null },
    providerUsed: 'mock',
  };
}

beforeEach(() => {
  mockAiStreamRound.mockReset();
  mockReadFile.mockClear();
  mockWriteFile.mockClear();
  mockListDirectory.mockClear();
  mockSearchCode.mockClear();
  mockFileExists.mockClear();
  mockDeleteFile.mockClear();
  mockCommitChanges.mockClear();
  mockManagePackages.mockClear();
  mockRevertFileToMain.mockClear();
  logMock.error.mockClear();
  logMock.info.mockClear();
  logMock.warn.mockClear();
});

describe('DevAgent.run — loop termination', () => {
  test('returns text immediately when model produces no tool calls', async () => {
    mockAiStreamRound.mockResolvedValueOnce(textResult('Implemented it.'));
    const agent = new DevAgent('/tmp/worktree');
    const text = await agent.run('system', 'user');
    expect(text).toBe('Implemented it.');
    expect(mockAiStreamRound).toHaveBeenCalledTimes(1);
  });

  test('sends nudge message when final response has empty text', async () => {
    mockAiStreamRound.mockResolvedValueOnce(textResult(''));
    mockAiStreamRound.mockResolvedValueOnce(textResult('Final answer here.'));
    const agent = new DevAgent('/tmp/worktree');
    const text = await agent.run('system', 'user');
    expect(text).toBe('Final answer here.');
    // First loop + nudge round = 2 calls
    expect(mockAiStreamRound).toHaveBeenCalledTimes(2);
  });
});

describe('DevAgent.run — tool dispatch', () => {
  test('executes write_file tool then finishes on next round', async () => {
    mockAiStreamRound.mockResolvedValueOnce(
      toolResult([
        {
          id: 'call_1',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'src/foo.ts', content: 'x' }),
        },
      ]),
    );
    mockAiStreamRound.mockResolvedValueOnce(textResult('Done'));

    const agent = new DevAgent('/tmp/worktree');
    const text = await agent.run('sys', 'msg');

    expect(text).toBe('Done');
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    expect(mockWriteFile).toHaveBeenCalledWith('/tmp/worktree', 'src/foo.ts', 'x');
  });

  test('executes commit tool and routes to git-ops.commitChanges', async () => {
    mockAiStreamRound.mockResolvedValueOnce(
      toolResult([
        {
          id: 'call_c',
          name: 'commit',
          arguments: JSON.stringify({ message: 'feat: stuff' }),
        },
      ]),
    );
    mockAiStreamRound.mockResolvedValueOnce(textResult('committed'));

    const agent = new DevAgent('/tmp/wt');
    await agent.run('sys', 'msg');

    expect(mockCommitChanges).toHaveBeenCalledWith('/tmp/wt', 'feat: stuff');
  });

  test('executes manage_packages with validated action', async () => {
    mockAiStreamRound.mockResolvedValueOnce(
      toolResult([
        {
          id: 'p1',
          name: 'manage_packages',
          arguments: JSON.stringify({ action: 'add', packages: 'zod' }),
        },
      ]),
    );
    mockAiStreamRound.mockResolvedValueOnce(textResult('ok'));
    const agent = new DevAgent('/tmp/wt');
    await agent.run('sys', 'msg');
    expect(mockManagePackages).toHaveBeenCalledWith('/tmp/wt', 'add', 'zod');
  });

  test('returns error string for malformed tool JSON instead of crashing', async () => {
    mockAiStreamRound.mockResolvedValueOnce(
      toolResult([{ id: 'b1', name: 'read_file', arguments: '{not json' }]),
    );
    mockAiStreamRound.mockResolvedValueOnce(textResult('recovered'));

    const agent = new DevAgent('/tmp/wt');
    const text = await agent.run('sys', 'msg');
    expect(text).toBe('recovered');
    expect(mockReadFile).not.toHaveBeenCalled();
    // The malformed args should have been logged as an error
    expect(logMock.error).toHaveBeenCalled();
  });

  test('unknown tool name returns error string without crashing', async () => {
    mockAiStreamRound.mockResolvedValueOnce(
      toolResult([{ id: 'u1', name: 'does_not_exist', arguments: '{}' }]),
    );
    mockAiStreamRound.mockResolvedValueOnce(textResult('ok'));
    const agent = new DevAgent('/tmp/wt');
    const text = await agent.run('sys', 'msg');
    expect(text).toBe('ok');
    // None of the real tools should have been hit
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  test('rejects manage_packages with invalid action (not add/remove)', async () => {
    mockAiStreamRound.mockResolvedValueOnce(
      toolResult([
        {
          id: 'p2',
          name: 'manage_packages',
          arguments: JSON.stringify({ action: 'nuke', packages: 'zod' }),
        },
      ]),
    );
    mockAiStreamRound.mockResolvedValueOnce(textResult('ok'));
    const agent = new DevAgent('/tmp/wt');
    await agent.run('sys', 'msg');
    // Bad action => real managePackages must NOT be called
    expect(mockManagePackages).not.toHaveBeenCalled();
  });

  test('captures error from a file-op tool and continues', async () => {
    mockReadFile.mockImplementationOnce(async () => {
      throw new Error('ENOENT: boom');
    });
    mockAiStreamRound.mockResolvedValueOnce(
      toolResult([
        { id: 'r1', name: 'read_file', arguments: JSON.stringify({ path: 'missing.ts' }) },
      ]),
    );
    mockAiStreamRound.mockResolvedValueOnce(textResult('handled'));

    const agent = new DevAgent('/tmp/wt');
    const text = await agent.run('sys', 'msg');
    // Agent should swallow the thrown error into a tool result and keep going
    expect(text).toBe('handled');
  });
});

describe('DevAgent.run — abort handling', () => {
  test('abort() throws AgentAbortedError when aiStreamRound rejects with AbortError', async () => {
    mockAiStreamRound.mockImplementationOnce(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const agent = new DevAgent('/tmp/wt');
    // Flip the internal abort flag BEFORE awaiting, so the catch-block throws AgentAbortedError
    agent.abort();
    await expect(agent.run('sys', 'msg')).rejects.toBeInstanceOf(AgentAbortedError);
  });
});

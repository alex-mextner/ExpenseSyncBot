// Tests for ocr-extractor.ts — temp cleanup logic and error handling
// Mocks aiStreamRound() from the shared streaming utility.

import { afterEach, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

function streamResult(text: string) {
  return {
    text,
    toolCalls: [],
    finishReason: 'stop',
    assistantMessage: { role: 'assistant' as const, content: text },
    providerUsed: 'mock-ocr',
  };
}

const mockAiStreamRound = mock(() =>
  Promise.resolve(streamResult('Store: Test\nItem: Milk - 100 RSD')),
);

mock.module('../ai/streaming', () => ({
  aiStreamRound: mockAiStreamRound,
  stripThinkingTags: (t: string) => t,
}));

import {
  extractTextFromImage,
  extractTextFromImageBuffer,
  startTempImageCleanup,
} from './ocr-extractor';

describe('startTempImageCleanup', () => {
  it('is a function', () => {
    expect(typeof startTempImageCleanup).toBe('function');
  });

  it('does not throw when called', () => {
    expect(() => startTempImageCleanup()).not.toThrow();
  });

  it('returns void (undefined)', () => {
    const result = startTempImageCleanup();
    expect(result).toBeUndefined();
  });

  it('can be called multiple times without throwing', () => {
    expect(() => {
      startTempImageCleanup();
      startTempImageCleanup();
    }).not.toThrow();
  });
});

describe('extractTextFromImageBuffer', () => {
  afterEach(() => {
    mockAiStreamRound.mockClear();
  });

  it('returns extracted text on success', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('Store: Mega\nMilk - 100 RSD'));

    const result = await extractTextFromImageBuffer(Buffer.from('fake-image'));
    expect(result).toBe('Store: Mega\nMilk - 100 RSD');
  });

  it('passes chain: ocr to aiStreamRound', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('text'));

    await extractTextFromImageBuffer(Buffer.from('fake'));

    expect(mockAiStreamRound).toHaveBeenCalledTimes(1);
    const opts = (mockAiStreamRound.mock.calls[0] as unknown as [{ chain?: string }])[0];
    expect(opts.chain).toBe('ocr');
  });

  it('passes base64 data URL in message content', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('text'));

    await extractTextFromImageBuffer(Buffer.from('test-data'));

    const opts = (
      mockAiStreamRound.mock.calls[0] as unknown as [
        { messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }> },
      ]
    )[0];
    const imageBlock = opts.messages[0]?.content[0];
    expect(imageBlock?.type).toBe('image_url');
    expect(imageBlock?.image_url?.url).toContain('data:image/jpeg;base64,');
  });

  it('throws when aiStreamRound fails', async () => {
    mockAiStreamRound.mockRejectedValueOnce(new Error('All providers in ocr chain failed'));

    await expect(extractTextFromImageBuffer(Buffer.from('fake'))).rejects.toThrow();
  });
});

describe('extractTextFromImage', () => {
  afterEach(async () => {
    mockAiStreamRound.mockClear();
    const fs = await import('node:fs/promises');
    const tempDir = path.join(process.cwd(), 'temp-images');
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('is a function', () => {
    expect(typeof extractTextFromImage).toBe('function');
  });

  it('returns text on success', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('Store: Test\nTotal: 500 RSD'));

    const result = await extractTextFromImage(Buffer.from('fake-image'));
    expect(result).toBe('Store: Test\nTotal: 500 RSD');
  });

  it('throws descriptive error when aiStreamRound fails', async () => {
    mockAiStreamRound.mockRejectedValueOnce(new Error('All providers in ocr chain failed'));

    try {
      await extractTextFromImage(Buffer.from('fake'));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err instanceof Error).toBe(true);
      if (err instanceof Error) {
        expect(err.message).toContain('OCR extraction failed');
      }
    }
  });
});

describe('temp image file lifecycle', () => {
  const fs = require('node:fs/promises') as typeof import('node:fs/promises');
  const tempDir = path.join(process.cwd(), 'temp-images');

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Directory may not exist
    }
  });

  it('temp-images directory path is under cwd', () => {
    expect(tempDir).toContain('temp-images');
    expect(path.isAbsolute(tempDir)).toBe(true);
  });

  it('can create and delete temp directory', async () => {
    await fs.mkdir(tempDir, { recursive: true });
    const stat = await fs.stat(tempDir);
    expect(stat.isDirectory()).toBe(true);

    await fs.rm(tempDir, { recursive: true });
    await expect(fs.access(tempDir)).rejects.toThrow();
  });

  it('can write and read a temp image file', async () => {
    await fs.mkdir(tempDir, { recursive: true });
    const filepath = path.join(tempDir, 'test-ocr.jpg');
    const buffer = Buffer.from('fake-image-bytes');

    await fs.writeFile(filepath, buffer);
    const read = await fs.readFile(filepath);
    expect(read).toEqual(buffer);

    await fs.unlink(filepath);
  });
});

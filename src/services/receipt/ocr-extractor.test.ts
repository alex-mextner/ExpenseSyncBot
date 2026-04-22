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

const mockAiStreamRound = mock<
  (opts: Record<string, unknown>) => Promise<ReturnType<typeof streamResult>>
>(() => Promise.resolve(streamResult('Store: Test\nItem: Milk - 100 RSD')));

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

// ── Additional error/sanitization paths ──────────────────────────────────
describe('extractTextFromImageBuffer — sanitization & edge cases', () => {
  afterEach(() => {
    mockAiStreamRound.mockClear();
  });

  it('returns empty string when AI output is a repetition loop', async () => {
    // Build a string where a 100-char mid sample repeats >5 times
    const pattern = 'REPEAT_BLOCK'.padEnd(100, 'x');
    const text = pattern.repeat(20); // well over 1000 chars, same block repeats
    mockAiStreamRound.mockResolvedValueOnce({
      text,
      toolCalls: [],
      finishReason: 'stop',
      assistantMessage: { role: 'assistant', content: text },
      providerUsed: 'mock-ocr',
    });

    const result = await extractTextFromImageBuffer(Buffer.from('fake'));
    expect(result).toBe('');
  });

  it('truncates output longer than 8000 chars to the sanity limit', async () => {
    // Use a deterministic non-repeating sequence — the loop detector extracts a
    // 100-char window from the middle and counts occurrences; we need < 5 matches.
    // LCG-style pseudo-random is enough to defeat substring repetition.
    let seed = 12345;
    const text = Array.from({ length: 9500 }, () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return String.fromCharCode(33 + (seed % 90));
    }).join('');

    mockAiStreamRound.mockResolvedValueOnce({
      text,
      toolCalls: [],
      finishReason: 'stop',
      assistantMessage: { role: 'assistant', content: text },
      providerUsed: 'mock-ocr',
    });

    const result = await extractTextFromImageBuffer(Buffer.from('fake'));
    expect(result.length).toBe(8000);
    expect(result).toBe(text.substring(0, 8000));
  });

  it('returns NO_TEXT literal when model signals blank receipt', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('NO_TEXT'));

    const result = await extractTextFromImageBuffer(Buffer.from('blank'));
    expect(result).toBe('NO_TEXT');
  });

  it('returns empty string when AI returns empty text', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult(''));

    const result = await extractTextFromImageBuffer(Buffer.from('fake'));
    expect(result).toBe('');
  });

  it('accepts short repetition patterns that do not trigger loop detection', async () => {
    // Under 1000 chars → loop check bypassed entirely
    const text = 'ABC'.repeat(100); // 300 chars
    mockAiStreamRound.mockResolvedValueOnce(streamResult(text));

    const result = await extractTextFromImageBuffer(Buffer.from('fake'));
    expect(result).toBe(text);
  });

  it('passes low temperature (0.1) for deterministic OCR', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('ok'));

    await extractTextFromImageBuffer(Buffer.from('fake'));
    const opts = mockAiStreamRound.mock.calls[0]?.[0] as { temperature?: number };
    expect(opts.temperature).toBe(0.1);
  });

  it('requests maxTokens of 2000', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('ok'));

    await extractTextFromImageBuffer(Buffer.from('fake'));
    const opts = mockAiStreamRound.mock.calls[0]?.[0] as { maxTokens?: number };
    expect(opts.maxTokens).toBe(2000);
  });

  it('preserves receipt text with Cyrillic script', async () => {
    const cyrillic = 'Магазин Продукты\nМолоко — 100 RUB\nХлеб — 50 RUB\nИтого: 150 RUB';
    mockAiStreamRound.mockResolvedValueOnce(streamResult(cyrillic));

    const result = await extractTextFromImageBuffer(Buffer.from('fake'));
    expect(result).toBe(cyrillic);
  });

  it('preserves receipt text with mixed scripts (Serbian Latin + Cyrillic)', async () => {
    const mixed = 'Maxi prodavnica\nХлеб: 120 RSD\nUkupno: 120 RSD';
    mockAiStreamRound.mockResolvedValueOnce(streamResult(mixed));

    const result = await extractTextFromImageBuffer(Buffer.from('fake'));
    expect(result).toBe(mixed);
  });

  it('builds a valid base64 data URL from a non-trivial buffer', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('ok'));
    // 3 bytes → 4 base64 chars
    const buf = Buffer.from([0xff, 0xd8, 0xff]);

    await extractTextFromImageBuffer(buf);

    const opts = mockAiStreamRound.mock.calls[0]?.[0] as {
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
    };
    const url = opts.messages[0]?.content[0]?.image_url?.url ?? '';
    expect(url).toBe(`data:image/jpeg;base64,${buf.toString('base64')}`);
  });

  it('sends OCR_PROMPT text block alongside image', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('ok'));
    await extractTextFromImageBuffer(Buffer.from('x'));

    const opts = mockAiStreamRound.mock.calls[0]?.[0] as {
      messages: Array<{ content: Array<{ type: string; text?: string }> }>;
    };
    const textBlock = opts.messages[0]?.content[1];
    expect(textBlock?.type).toBe('text');
    expect(textBlock?.text).toContain('OCR');
  });
});

describe('extractTextFromImage — temp-file variant', () => {
  afterEach(async () => {
    mockAiStreamRound.mockClear();
    const fs = await import('node:fs/promises');
    const tempDir = path.join(process.cwd(), 'temp-images');
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('sanitizes runaway-repetition output to empty string', async () => {
    const pattern = 'LOOP_BLOCK'.padEnd(100, 'y');
    const text = pattern.repeat(20);
    mockAiStreamRound.mockResolvedValueOnce(streamResult(text));

    const result = await extractTextFromImage(Buffer.from('fake'));
    expect(result).toBe('');
  });

  it('truncates excessively long output to 8000 chars', async () => {
    let seed = 54321;
    const text = Array.from({ length: 9500 }, () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return String.fromCharCode(33 + (seed % 90));
    }).join('');
    mockAiStreamRound.mockResolvedValueOnce(streamResult(text));

    const result = await extractTextFromImage(Buffer.from('fake'));
    expect(result.length).toBe(8000);
  });

  it('writes image to temp-images directory', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('ocr'));

    await extractTextFromImage(Buffer.from('fake-image-bytes'));

    const fs = await import('node:fs/promises');
    const tempDir = path.join(process.cwd(), 'temp-images');
    const files = await fs.readdir(tempDir);
    const ocrFile = files.find((f) => f.startsWith('ocr-') && f.endsWith('.jpg'));
    expect(ocrFile).toBeDefined();
  });

  it('passes a URL-style image_url to the model (not data URL)', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('ocr'));

    await extractTextFromImage(Buffer.from('fake'));

    const opts = mockAiStreamRound.mock.calls[0]?.[0] as {
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
    };
    const url = opts.messages[0]?.content[0]?.image_url?.url ?? '';
    expect(url).toContain('/temp-images/ocr-');
    expect(url).not.toContain('data:image/jpeg;base64');
  });

  it('propagates a non-Error throw from aiStreamRound with "Unknown error" fallback', async () => {
    mockAiStreamRound.mockImplementationOnce(async () => {
      // eslint-disable-next-line no-throw-literal
      throw 'plain string rejection' as unknown as Error;
    });

    try {
      await extractTextFromImage(Buffer.from('fake'));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err instanceof Error).toBe(true);
      if (err instanceof Error) {
        expect(err.message).toContain('Unknown error');
      }
    }
  });

  it('returns NO_TEXT marker unchanged for blank images', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('NO_TEXT'));

    const result = await extractTextFromImage(Buffer.from('blank'));
    expect(result).toBe('NO_TEXT');
  });
});

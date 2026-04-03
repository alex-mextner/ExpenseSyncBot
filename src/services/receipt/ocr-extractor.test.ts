/** Tests for extractFromImage — structured KIE extraction with model fallback chain */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

const logMock = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
};
mock.module('../../utils/logger', () => ({
  createLogger: () => logMock,
}));

let chatCompletionMock: ReturnType<typeof mock>;

mock.module('@huggingface/inference', () => ({
  InferenceClient: class {
    chatCompletion(...args: unknown[]) {
      return chatCompletionMock(...args);
    }
  },
}));

const { extractFromImage } = await import('./ocr-extractor');

describe('extractFromImage', () => {
  beforeEach(() => {
    logMock.info.mockClear();
    logMock.warn.mockClear();
    logMock.error.mockClear();
  });

  it('extracts structured items via GLM-OCR (primary model)', async () => {
    chatCompletionMock = mock(() =>
      Promise.resolve({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [{ name: 'Молоко', quantity: 1, price: 89.99, total: 89.99 }],
                currency: 'RSD',
                store: 'Maxi',
              }),
            },
          },
        ],
      }),
    );

    const result = await extractFromImage(Buffer.from('fake-image'));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name).toBe('Молоко');
    expect(result.items[0]?.total).toBe(89.99);
    expect(result.currency).toBe('RSD');
    expect(result.store).toBe('Maxi');

    expect(chatCompletionMock).toHaveBeenCalledTimes(1);
    const callArgs = chatCompletionMock.mock.calls[0]?.[0] as { model: string; provider: string };
    expect(callArgs.model).toBe('zai-org/GLM-OCR');
    expect(callArgs.provider).toBe('zai-org');
  });

  it('falls back to Qwen when GLM-OCR fails', async () => {
    let callCount = 0;
    chatCompletionMock = mock(() => {
      callCount++;
      if (callCount === 1) throw new Error('GLM-OCR unavailable');
      return Promise.resolve({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [{ name: 'Хлеб', quantity: 2, price: 45, total: 90 }],
                currency: 'RSD',
              }),
            },
          },
        ],
      });
    });

    const result = await extractFromImage(Buffer.from('fake-image'));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name).toBe('Хлеб');
    expect(chatCompletionMock).toHaveBeenCalledTimes(2);
  });

  it('throws when all models fail', async () => {
    chatCompletionMock = mock(() => {
      throw new Error('Model failed');
    });
    await expect(extractFromImage(Buffer.from('fake-image'))).rejects.toThrow(
      'All OCR models failed',
    );
  });

  it('strips <think> blocks and code fences from response', async () => {
    chatCompletionMock = mock(() =>
      Promise.resolve({
        choices: [
          {
            message: {
              content:
                '<think>analyzing...</think>```json\n{"items": [{"name": "Сок", "quantity": 1, "price": 150, "total": 150}], "currency": "EUR"}\n```',
            },
          },
        ],
      }),
    );

    const result = await extractFromImage(Buffer.from('fake-image'));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name).toBe('Сок');
    expect(result.currency).toBe('EUR');
  });

  it('normalizes decimal commas (399,99 → 399.99)', async () => {
    chatCompletionMock = mock(() =>
      Promise.resolve({
        choices: [
          {
            message: {
              content:
                '{"items": [{"name": "Сыр", "quantity": 1, "price": 399,99, "total": 399,99}], "currency": "RSD"}',
            },
          },
        ],
      }),
    );

    const result = await extractFromImage(Buffer.from('fake-image'));
    expect(result.items[0]?.price).toBe(399.99);
    expect(result.items[0]?.total).toBe(399.99);
  });

  it('skips items missing required fields (name, total)', async () => {
    chatCompletionMock = mock(() =>
      Promise.resolve({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [
                  { quantity: 1, price: 100 },
                  { name: 'Хлеб', quantity: 1, price: 45, total: 45 },
                ],
                currency: 'RSD',
              }),
            },
          },
        ],
      }),
    );

    const result = await extractFromImage(Buffer.from('fake-image'));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name).toBe('Хлеб');
  });

  it('defaults quantity to 1 when missing', async () => {
    chatCompletionMock = mock(() =>
      Promise.resolve({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [{ name: 'Вода', price: 50, total: 50 }],
              }),
            },
          },
        ],
      }),
    );

    const result = await extractFromImage(Buffer.from('fake-image'));
    expect(result.items[0]?.quantity).toBe(1);
  });

  it('extracts optional fields (store, date, total)', async () => {
    chatCompletionMock = mock(() =>
      Promise.resolve({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [{ name: 'Молоко', quantity: 1, price: 89.99, total: 89.99 }],
                store: 'Maxi',
                date: '03.04.2026',
                currency: 'RSD',
                total: 89.99,
              }),
            },
          },
        ],
      }),
    );

    const result = await extractFromImage(Buffer.from('fake-image'));
    expect(result.store).toBe('Maxi');
    expect(result.date).toBe('03.04.2026');
    expect(result.total).toBe(89.99);
  });

  it('throws when no items extracted (empty array)', async () => {
    chatCompletionMock = mock(() =>
      Promise.resolve({
        choices: [{ message: { content: '{"items": []}' } }],
      }),
    );

    await expect(extractFromImage(Buffer.from('fake-image'))).rejects.toThrow('No items extracted');
  });

  it('throws when response is empty', async () => {
    chatCompletionMock = mock(() =>
      Promise.resolve({
        choices: [{ message: { content: '' } }],
      }),
    );

    await expect(extractFromImage(Buffer.from('fake-image'))).rejects.toThrow();
  });

  it('does not log errors on success path', async () => {
    chatCompletionMock = mock(() =>
      Promise.resolve({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [{ name: 'Вода', quantity: 1, price: 50, total: 50 }],
              }),
            },
          },
        ],
      }),
    );

    await extractFromImage(Buffer.from('fake-image'));
    expect(logMock.error).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { TranscriptionService } from './transcription-service';

const originalFetch = globalThis.fetch;

describe('TranscriptionService', () => {
  let service: TranscriptionService;

  beforeEach(() => {
    service = new TranscriptionService('gsk_test_token');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('sends OGG audio to Groq Whisper and trims the transcript', async () => {
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer gsk_test_token',
      );

      const body = init?.body as FormData;
      expect(body.get('model')).toBe('whisper-large-v3');
      expect(body.get('response_format')).toBe('json');
      const file = body.get('file') as Blob;
      expect(file.type).toBe('audio/ogg');
      return new Response(JSON.stringify({ text: '  кофе 3 500 динар  ' }));
    }) as unknown as typeof fetch;

    expect(await service.transcribe(Buffer.from('fake-ogg'))).toBe('кофе 3 500 динар');
  });

  test('returns empty text when Groq omits the text field', async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({})),
    ) as unknown as typeof fetch;
    expect(await service.transcribe(Buffer.from('fake-ogg'))).toBe('');
  });

  test('throws a status-only error and does not expose response contents', async () => {
    globalThis.fetch = mock(
      async () => new Response('provider-secret-diagnostic', { status: 503 }),
    ) as unknown as typeof fetch;

    await expect(service.transcribe(Buffer.from('fake-ogg'))).rejects.toThrow(
      'Whisper transcription failed: HTTP 503',
    );
  });
});

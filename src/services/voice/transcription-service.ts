import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('voice.transcription');
const GROQ_WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const WHISPER_MODEL = 'whisper-large-v3';

function extractText(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || !('text' in payload)) return '';
  const text = (payload as { text?: unknown }).text;
  return typeof text === 'string' ? text.trim() : '';
}

export class TranscriptionService {
  constructor(private readonly token: string) {}

  async transcribe(audioBuffer: Buffer): Promise<string> {
    const startedAt = Date.now();
    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg');
    form.append('model', WHISPER_MODEL);
    form.append('response_format', 'json');

    const response = await fetch(GROQ_WHISPER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      body: form,
    });

    if (!response.ok) {
      logger.error(
        { status: response.status, elapsedMs: Date.now() - startedAt },
        'Groq Whisper transcription failed',
      );
      throw new Error(`Whisper transcription failed: HTTP ${response.status}`);
    }

    const text = extractText(await response.json());
    logger.info(
      { elapsedMs: Date.now() - startedAt, textLength: text.length },
      'Voice message transcribed',
    );
    return text;
  }
}

// Verify startup configuration no longer requires legacy Gemini credentials or models.
import { expect, it } from 'bun:test';

it('accepts complete provider configuration without any Gemini settings', async () => {
  for (const name of [
    'BOT_TOKEN',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REDIRECT_URI',
    'ANTHROPIC_API_KEY',
    'AI_BASE_URL',
    'AI_MODEL',
    'AI_FAST_MODEL',
    'HF_TOKEN',
    'HF_BASE_URL',
    'HF_MODEL',
    'HF_FAST_MODEL',
    'HF_VISION_MODEL',
  ])
    process.env[name] = 'synthetic';
  for (const name of [
    'GEMINI_API_KEY',
    'GEMINI_BASE_URL',
    'GEMINI_MODEL',
    'GEMINI_FAST_MODEL',
    'GEMINI_VISION_MODEL',
  ]) {
    delete process.env[name];
  }
  const { env } = await import('./env');
  expect(env.GEMINI_API_KEY).toBe('');
  expect(env.GEMINI_MODEL).toBe('');
  expect(env.HF_VISION_MODEL).toBe('synthetic');
});

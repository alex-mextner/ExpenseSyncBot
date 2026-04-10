/** Quick test: vision models via OpenAI-compatible endpoints */
import { readFileSync } from 'node:fs';
import OpenAI from 'openai';

// Provider configs
const PROVIDERS: Record<string, { baseURL: string; apiKeyEnv: string; defaultModel: string }> = {
  zai: { baseURL: 'https://api.z.ai/api/paas/v4', apiKeyEnv: 'ANTHROPIC_API_KEY', defaultModel: 'glm-5.1' },
  gemini: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', apiKeyEnv: 'GEMINI_API_KEY', defaultModel: 'gemini-2.0-flash' },
  hf: { baseURL: 'https://router.huggingface.co/v1', apiKeyEnv: 'HF_TOKEN', defaultModel: 'Qwen/Qwen2.5-VL-72B-Instruct' },
};

const providerName = process.argv[3] || 'gemini';
const provider = PROVIDERS[providerName];
if (!provider) {
  console.error(`Unknown provider: ${providerName}. Available: ${Object.keys(PROVIDERS).join(', ')}`);
  process.exit(1);
}

const API_KEY = process.env[provider.apiKeyEnv];
const MODEL = process.env['AI_MODEL'] || provider.defaultModel;

if (!API_KEY) {
  console.error(`${provider.apiKeyEnv} not set`);
  process.exit(1);
}

const imagePath = process.argv[2];
if (!imagePath) {
  console.error('Usage: bun scripts/test-vision.ts <image-path> [provider]');
  console.error('Providers: zai, gemini');
  process.exit(1);
}

const imageBuffer = readFileSync(imagePath);
const base64 = imageBuffer.toString('base64');
const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
const dataUrl = `data:${mimeType};base64,${base64}`;

console.log(`Image: ${imagePath} (${imageBuffer.length} bytes)`);
console.log(`Provider: ${providerName}`);
console.log(`Model: ${MODEL}`);
console.log(`Base URL: ${provider.baseURL}`);
console.log('---');

const client = new OpenAI({
  apiKey: API_KEY,
  baseURL: provider.baseURL,
  timeout: 60_000,
  maxRetries: 0,
});

try {
  const t0 = Date.now();
  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          {
            type: 'text',
            text: 'Extract ALL text from this receipt image. Include store name, dates, items, prices, totals. Return text as-is.',
          },
        ],
      },
    ],
    max_tokens: 2000,
    temperature: 0.1,
  });

  const elapsed = Date.now() - t0;
  const text = response.choices[0]?.message?.content?.trim();
  console.log(`✅ GLM vision OK (${elapsed}ms, ${text?.length ?? 0} chars)`);
  console.log('---');
  console.log(text);
  console.log('---');
  console.log(`finish_reason: ${response.choices[0]?.finish_reason}`);
  console.log(`usage: ${JSON.stringify(response.usage)}`);
} catch (error) {
  console.error('❌ GLM vision FAILED:');
  if (error instanceof OpenAI.APIError) {
    console.error(`  Status: ${error.status}`);
    console.error(`  Message: ${error.message}`);
  } else if (error instanceof Error) {
    console.error(`  ${error.message}`);
  }
  process.exit(1);
}

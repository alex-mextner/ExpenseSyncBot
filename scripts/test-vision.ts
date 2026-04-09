/** Quick test: does GLM handle vision (image_url) via z.ai OpenAI endpoint? */
import { readFileSync } from 'node:fs';
import OpenAI from 'openai';

const ZAI_BASE = 'https://api.z.ai/api/paas/v4';
const API_KEY = process.env['ANTHROPIC_API_KEY'];
const MODEL = process.env['AI_MODEL'] || 'glm-5.1';

if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY not set');
  process.exit(1);
}

const imagePath = process.argv[2];
if (!imagePath) {
  console.error('Usage: bun scripts/test-vision.ts <image-path>');
  process.exit(1);
}

const imageBuffer = readFileSync(imagePath);
const base64 = imageBuffer.toString('base64');
const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
const dataUrl = `data:${mimeType};base64,${base64}`;

console.log(`Image: ${imagePath} (${imageBuffer.length} bytes)`);
console.log(`Model: ${MODEL}`);
console.log(`Base URL: ${ZAI_BASE}`);
console.log('---');

const client = new OpenAI({
  apiKey: API_KEY,
  baseURL: ZAI_BASE,
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

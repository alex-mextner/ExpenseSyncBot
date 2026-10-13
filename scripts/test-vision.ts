/**
 * Quick probe: send one receipt image to a single vision provider and print the raw answer.
 * Uses the bot's own clients, base URLs, models and request shape (chatRequestParams), so it
 * tests exactly what production sends. Override a model inline, e.g.
 *   CLAUDE_VISION_MODEL=claude-haiku-5-5 bun scripts/test-vision.ts receipt.jpg claude
 */
import { readFileSync } from 'node:fs';
import OpenAI from 'openai';
import { env } from '../src/config/env';
import { claudeClient, hfClient, zaiClient } from '../src/services/ai/clients';
import { chatRequestParams } from '../src/services/ai/streaming';

const PROVIDERS: Record<string, { client: () => OpenAI; model: string; anthropic: boolean }> = {
  claude: { client: claudeClient, model: env.CLAUDE_VISION_MODEL, anthropic: true },
  hf: { client: hfClient, model: env.HF_VISION_MODEL, anthropic: false },
  zai: { client: zaiClient, model: env.AI_MODEL, anthropic: false },
};

// The probe's report is its product: write it to stdout (same convention as replay-ai-logs.ts).
function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

const imagePath = process.argv[2];
const providerName = process.argv[3] || 'claude';
const provider = PROVIDERS[providerName];
if (!imagePath || !provider) {
  console.error('Usage: bun scripts/test-vision.ts <image-path> [provider]');
  console.error(`Providers: ${Object.keys(PROVIDERS).join(', ')}`);
  process.exit(1);
}

const imageBuffer = readFileSync(imagePath);
const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
const dataUrl = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;

say(`Image: ${imagePath} (${imageBuffer.length} bytes)`);
say(`Provider: ${providerName}`);
say(`Model: ${provider.model}`);
say('---');

try {
  const t0 = Date.now();
  const response = await provider.client().chat.completions.create({
    model: provider.model,
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
    ...chatRequestParams(provider.model, 2000, 0.1, provider.anthropic),
  });

  const elapsed = Date.now() - t0;
  const text = response.choices[0]?.message?.content?.trim();
  say(`✅ ${providerName} vision OK (${elapsed}ms, ${text?.length ?? 0} chars)`);
  say('---');
  say(text ?? '(no text content in the response)');
  say('---');
  say(`finish_reason: ${response.choices[0]?.finish_reason}`);
  say(`usage: ${JSON.stringify(response.usage)}`);
} catch (error) {
  console.error(`❌ ${providerName} vision FAILED:`);
  if (error instanceof OpenAI.APIError) {
    console.error(`  Status: ${error.status}`);
    console.error(`  Message: ${error.message}`);
  } else if (error instanceof Error) {
    console.error(`  ${error.message}`);
  }
  process.exit(1);
}

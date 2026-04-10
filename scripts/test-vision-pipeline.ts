/** Integration test: aiComplete vision chain with real receipt image */
import { readFileSync } from 'node:fs';
import { aiComplete } from '../src/services/ai/completion';

const imagePath = process.argv[2];
if (!imagePath) {
  console.error('Usage: bun scripts/test-vision-pipeline.ts <image-path>');
  process.exit(1);
}

const imageBuffer = readFileSync(imagePath);
const dataUrl = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;

console.log(`Image: ${imagePath} (${imageBuffer.length} bytes)`);
console.log('---');

const t0 = Date.now();
try {
  const result = await aiComplete({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          {
            type: 'text',
            text: 'Extract ALL text from this receipt image. Include store name, dates, items, prices, totals.',
          },
        ],
      },
    ],
    maxTokens: 2000,
    temperature: 0.1,
    vision: true,
  });

  const elapsed = Date.now() - t0;
  console.log(`✅ Vision OK via ${result.model} (${elapsed}ms)`);
  console.log('---');
  console.log(result.text);
  console.log('---');
  console.log(`finish: ${result.finishReason}, usage: ${JSON.stringify(result.usage)}`);
} catch (error) {
  console.error('❌ Vision FAILED:');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

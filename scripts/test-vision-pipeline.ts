/** Integration test: OCR chain with real receipt image */
import { readFileSync } from 'node:fs';
import { aiStreamRound } from '../src/services/ai/streaming';

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
  const result = await aiStreamRound({
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
    chain: 'ocr',
  });

  const elapsed = Date.now() - t0;
  console.log(`OK Vision via ${result.providerUsed} (${elapsed}ms)`);
  console.log('---');
  console.log(result.text);
  console.log('---');
  console.log(`finish: ${result.finishReason}`);
} catch (error) {
  console.error('FAILED:');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

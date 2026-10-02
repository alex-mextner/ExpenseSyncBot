/** Test GLM-OCR via imageToText() — does it return structured KIE JSON? */
import sharp from 'sharp';
import { InferenceClient } from '@huggingface/inference';

const HF_TOKEN = process.env.HF_TOKEN;
if (!HF_TOKEN) { console.error('HF_TOKEN not set'); process.exit(1); }

const client = new InferenceClient(HF_TOKEN);

// Create a receipt-like image with sharp (white background, some text would be ideal but sharp can't add text easily)
// Use a real small JPEG — just needs to be valid
const imageBuffer = await sharp({
  create: { width: 200, height: 300, channels: 3, background: { r: 255, g: 255, b: 255 } },
}).jpeg({ quality: 80 }).toBuffer();

const KIE_SCHEMA = `{"items": [{"name": "item name", "quantity": 1, "price": 100.00, "total": 100.00}], "store": "store name", "date": "DD.MM.YYYY", "currency": "RSD", "total": 1234.56}`;

// Test 1: imageToText with prompt
console.log('=== Test 1: imageToText() ===');
try {
  const t0 = Date.now();
  const result = await client.imageToText({
    provider: 'zai-org',
    model: 'zai-org/GLM-OCR',
    data: imageBuffer,
    parameters: {
      prompt: `Extract receipt items as JSON matching: ${KIE_SCHEMA}`,
    },
  });
  console.log(`✅ ${Date.now() - t0}ms:`, JSON.stringify(result).slice(0, 300));
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log(`❌ ${msg.slice(0, 200)}`);
}

// Test 2: imageToText without prompt
console.log('\n=== Test 2: imageToText() no prompt ===');
try {
  const t0 = Date.now();
  const result = await client.imageToText({
    provider: 'zai-org',
    model: 'zai-org/GLM-OCR',
    data: imageBuffer,
  });
  console.log(`✅ ${Date.now() - t0}ms:`, JSON.stringify(result).slice(0, 300));
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log(`❌ ${msg.slice(0, 200)}`);
}

// Test 3: raw fetch to zai-org API (chat format, bypassing HF routing)
console.log('\n=== Test 3: raw fetch chat format ===');
try {
  const dataUrl = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
  const t0 = Date.now();
  const resp = await fetch('https://router.huggingface.co/zai-org/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HF_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'zai-org/GLM-OCR',
      messages: [
        { role: 'system', content: `Extract receipt items as JSON. Return ONLY valid JSON matching this schema:\n${KIE_SCHEMA}` },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: 'Extract all items from this receipt image.' },
        ]},
      ],
      max_tokens: 4096,
      temperature: 0.1,
    }),
  });
  const body = await resp.text();
  console.log(`${resp.status} ${Date.now() - t0}ms:`, body.slice(0, 300));
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log(`❌ ${msg.slice(0, 200)}`);
}

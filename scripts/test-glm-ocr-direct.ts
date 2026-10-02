/** Test GLM-OCR via different API routes to find which one actually works */
import sharp from 'sharp';
import { InferenceClient } from '@huggingface/inference';

const HF_TOKEN = process.env.HF_TOKEN;
if (!HF_TOKEN) { console.error('HF_TOKEN not set'); process.exit(1); }

const client = new InferenceClient(HF_TOKEN);
const imageBuffer = await sharp({
  create: { width: 200, height: 300, channels: 3, background: { r: 255, g: 255, b: 255 } },
}).jpeg({ quality: 80 }).toBuffer();
const dataUrl = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
const KIE_SCHEMA = `{"items": [{"name": "item name", "quantity": 1, "price": 100.00, "total": 100.00}], "store": "store name", "date": "DD.MM.YYYY", "currency": "RSD", "total": 1234.56}`;

// 1. chatCompletion WITHOUT provider (HF default inference)
console.log('=== 1: chatCompletion, NO provider ===');
try {
  const t0 = Date.now();
  const r = await client.chatCompletion({
    model: 'zai-org/GLM-OCR',
    messages: [
      { role: 'system', content: `Extract receipt items as JSON:\n${KIE_SCHEMA}` },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: 'Extract items.' },
      ]},
    ],
    max_tokens: 2048,
    temperature: 0.1,
  });
  console.log(`✅ ${Date.now() - t0}ms:`, r.choices[0]?.message?.content?.slice(0, 200));
} catch (e: unknown) { console.log(`❌ ${(e as Error).message?.slice(0, 200)}`); }

// 2. chatCompletionStream WITHOUT provider
console.log('\n=== 2: chatCompletionStream, NO provider ===');
try {
  const t0 = Date.now();
  const stream = client.chatCompletionStream({
    model: 'zai-org/GLM-OCR',
    messages: [
      { role: 'system', content: `Extract receipt items as JSON:\n${KIE_SCHEMA}` },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: 'Extract items.' },
      ]},
    ],
    max_tokens: 2048,
    temperature: 0.1,
  });
  let chunks = 0, text = '';
  for await (const c of stream) { const t = c.choices?.[0]?.delta?.content; if (t) { chunks++; text += t; } }
  console.log(`✅ ${Date.now() - t0}ms, ${chunks} chunks:`, text.slice(0, 200));
} catch (e: unknown) { console.log(`❌ ${(e as Error).message?.slice(0, 200)}`); }

// 3. imageToText WITHOUT provider
console.log('\n=== 3: imageToText, NO provider ===');
try {
  const t0 = Date.now();
  const r = await client.imageToText({ model: 'zai-org/GLM-OCR', data: imageBuffer });
  console.log(`✅ ${Date.now() - t0}ms:`, JSON.stringify(r).slice(0, 200));
} catch (e: unknown) { console.log(`❌ ${(e as Error).message?.slice(0, 200)}`); }

// 4. Raw HF Inference API (serverless)
console.log('\n=== 4: raw fetch to HF serverless inference ===');
try {
  const t0 = Date.now();
  const r = await fetch('https://api-inference.huggingface.co/models/zai-org/GLM-OCR', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: dataUrl, parameters: { max_new_tokens: 2048 } }),
  });
  const body = await r.text();
  console.log(`${r.status} ${Date.now() - t0}ms:`, body.slice(0, 300));
} catch (e: unknown) { console.log(`❌ ${(e as Error).message?.slice(0, 200)}`); }

// 5. Z.ai direct API
console.log('\n=== 5: Z.ai direct API (chat format) ===');
try {
  const t0 = Date.now();
  const r = await fetch('https://open.z.ai/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'GLM-OCR',
      messages: [
        { role: 'system', content: `Extract receipt items as JSON:\n${KIE_SCHEMA}` },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: 'Extract items.' },
        ]},
      ],
      max_tokens: 2048,
    }),
  });
  const body = await r.text();
  console.log(`${r.status} ${Date.now() - t0}ms:`, body.slice(0, 300));
} catch (e: unknown) { console.log(`❌ ${(e as Error).message?.slice(0, 200)}`); }

/** Test glm-5v-turbo via HF zai-org provider: chat completion + streaming + vision */
import sharp from 'sharp';
import { InferenceClient } from '@huggingface/inference';

const HF_TOKEN = process.env.HF_TOKEN;
if (!HF_TOKEN) { console.error('HF_TOKEN not set'); process.exit(1); }

const client = new InferenceClient(HF_TOKEN);

const imageBuffer = await sharp({
  create: { width: 200, height: 300, channels: 3, background: { r: 255, g: 255, b: 255 } },
}).jpeg({ quality: 80 }).toBuffer();
const dataUrl = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;

const KIE_PROMPT = `Extract receipt items as JSON. Return ONLY valid JSON matching this schema:
{"items": [{"name_ru": "item name in Russian", "quantity": 1, "price": 100.00, "total": 100.00, "category": "Category"}], "currency": "RSD"}
This is a blank test image, return empty items array.`;

// Try multiple model ID formats
const models = [
  { provider: 'zai-org', model: 'zai-org/glm-5v-turbo', name: 'glm-5v-turbo (zai-org/)' },
  { provider: 'zai-org', model: 'glm-5v-turbo', name: 'glm-5v-turbo (short)' },
  { provider: 'zai-org', model: 'zai-org/GLM-4.6V-Flash', name: 'GLM-4.6V-Flash' },
] as const;

for (const m of models) {
  console.log(`\n=== ${m.name} ===`);

  const messages = [
    { role: 'user' as const, content: [
      { type: 'image_url' as const, image_url: { url: dataUrl } },
      { type: 'text' as const, text: KIE_PROMPT },
    ]},
  ];

  // Stream
  console.log('  [stream] trying...');
  const t0 = Date.now();
  try {
    const stream = client.chatCompletionStream({
      provider: m.provider,
      model: m.model,
      messages,
      max_tokens: 200,
      temperature: 0.1,
    });
    let chunks = 0, text = '';
    for await (const c of stream) {
      const t = c.choices?.[0]?.delta?.content;
      if (t) { chunks++; text += t; }
    }
    console.log(`  [stream] ✅ ${chunks} chunks, ${Date.now() - t0}ms: "${text.slice(0, 150)}"`);
  } catch (e: unknown) {
    console.log(`  [stream] ❌ ${Date.now() - t0}ms: ${(e as Error).message?.slice(0, 150)}`);
  }

  // Batch
  console.log('  [batch]  trying...');
  const t1 = Date.now();
  try {
    const r = await client.chatCompletion({
      provider: m.provider,
      model: m.model,
      messages,
      max_tokens: 200,
      temperature: 0.1,
    });
    console.log(`  [batch]  ✅ ${Date.now() - t1}ms: "${r.choices[0]?.message?.content?.slice(0, 150)}"`);
  } catch (e: unknown) {
    console.log(`  [batch]  ❌ ${Date.now() - t1}ms: ${(e as Error).message?.slice(0, 150)}`);
  }
}

/** Quick test: does Qwen2.5-VL-72B support chatCompletionStream via HF default provider? */
import sharp from 'sharp';
import { InferenceClient } from '@huggingface/inference';

const HF_TOKEN = process.env.HF_TOKEN;
if (!HF_TOKEN) {
  console.error('HF_TOKEN not set');
  process.exit(1);
}

const client = new InferenceClient(HF_TOKEN);

// Create a small but valid image with text-like content (100x60 white JPEG)
const imageBuffer = await sharp({
  create: { width: 100, height: 60, channels: 3, background: { r: 255, g: 255, b: 255 } },
})
  .jpeg({ quality: 80 })
  .toBuffer();

const dataUrl = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;

const models = [
  { model: 'Qwen/Qwen2.5-VL-72B-Instruct', provider: undefined, name: 'Qwen2.5-VL-72B (HF default)' },
  { model: 'zai-org/GLM-OCR', provider: 'zai-org', name: 'GLM-OCR (zai-org)' },
] as const;

for (const m of models) {
  console.log(`\n=== ${m.name} ===`);

  const messages = [
    {
      role: 'user' as const,
      content: [
        { type: 'image_url' as const, image_url: { url: dataUrl } },
        { type: 'text' as const, text: 'What do you see? Reply in 1 sentence.' },
      ],
    },
  ];

  // Test streaming
  console.log('  [stream] trying...');
  const t0 = Date.now();
  try {
    const stream = client.chatCompletionStream({
      ...(m.provider ? { provider: m.provider } : {}),
      model: m.model,
      messages,
      max_tokens: 100,
      temperature: 0.1,
    });

    let chunks = 0;
    let text = '';
    for await (const chunk of stream) {
      const c = chunk.choices?.[0]?.delta?.content;
      if (c) {
        chunks++;
        text += c;
      }
    }
    const ms = Date.now() - t0;
    console.log(`  [stream] ✅ ${chunks} chunks, ${ms}ms: "${text.slice(0, 80)}"`);
  } catch (err: unknown) {
    const ms = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [stream] ❌ ${ms}ms: ${msg.slice(0, 120)}`);
  }

  // Test non-streaming
  console.log('  [batch]  trying...');
  const t1 = Date.now();
  try {
    const resp = await client.chatCompletion({
      ...(m.provider ? { provider: m.provider } : {}),
      model: m.model,
      messages,
      max_tokens: 100,
      temperature: 0.1,
    });
    const ms = Date.now() - t1;
    const text = resp.choices[0]?.message?.content ?? '(empty)';
    console.log(`  [batch]  ✅ ${ms}ms: "${text.slice(0, 80)}"`);
  } catch (err: unknown) {
    const ms = Date.now() - t1;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [batch]  ❌ ${ms}ms: ${msg.slice(0, 120)}`);
  }
}

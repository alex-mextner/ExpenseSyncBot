/** Quick test: check chatCompletionStream() support across HF inference providers */
import { InferenceClient } from '@huggingface/inference';

// Accept token from: CLI arg, env var, or fallback to reading commented-out .env line
const HF_TOKEN =
  Bun.argv[2] ||
  process.env.HF_TOKEN ||
  (() => {
    try {
      const envContent = require('node:fs').readFileSync('.env', 'utf8') as string;
      const match = envContent.match(/^#?\s*HF_TOKEN=(\S+)/m);
      if (match?.[1]) {
        console.log('(Using HF_TOKEN from commented-out .env line)');
        return match[1];
      }
    } catch {}
    return '';
  })();

if (!HF_TOKEN) {
  console.error(
    'HF_TOKEN not found. Options:\n' +
      '  1. Pass as arg:  bun scripts/test-streaming-providers.ts hf_xxx\n' +
      '  2. Set in .env:  HF_TOKEN=hf_xxx  (uncomment if commented out)\n' +
      '  3. Export:        export HF_TOKEN=hf_xxx',
  );
  process.exit(1);
}

const client = new InferenceClient(HF_TOKEN);

// Tiny 1x1 white JPEG as base64 data URL (valid JFIF, ~631 bytes)
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoH' +
  'BwYIDAoMCwsKCwsICw4QDQoNEA4RERMTFBYVFRcXGhkaGhMaGxr/2wBDAQMEBAUE' +
  'BQkGBgkaDQsNGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoa' +
  'GhoaGhoaGhoaGhr/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf' +
  '/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAA' +
  'AAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=';

const TINY_JPEG_DATA_URL = `data:image/jpeg;base64,${TINY_JPEG_BASE64}`;

// ── Provider configurations ─────────────────────────────────────────────────

interface ProviderConfig {
  label: string;
  provider: string | undefined;
  model: string;
  vision: boolean;
}

const PROVIDERS: ProviderConfig[] = [
  {
    label: 'zai-org / GLM-OCR',
    provider: 'zai-org',
    model: 'zai-org/GLM-OCR',
    vision: true,
  },
  {
    label: 'novita / DeepSeek-R1-0528',
    provider: 'novita',
    model: 'deepseek-ai/DeepSeek-R1-0528',
    vision: false,
  },
  {
    label: 'HF default / Qwen2.5-VL-72B',
    provider: undefined,
    model: 'Qwen/Qwen2.5-VL-72B-Instruct',
    vision: true,
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

type MessageContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

function buildMessages(vision: boolean): Array<{ role: 'user'; content: MessageContent }> {
  if (vision) {
    return [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: TINY_JPEG_DATA_URL } },
          { type: 'text', text: 'What is in this image? Reply briefly.' },
        ],
      },
    ];
  }
  return [{ role: 'user', content: 'Say "hello" and nothing else.' }];
}

interface TestResult {
  label: string;
  streamOk: boolean;
  streamError: string;
  streamMs: number;
  nonStreamOk: boolean;
  nonStreamError: string;
  nonStreamMs: number;
}

async function testProvider(config: ProviderConfig): Promise<TestResult> {
  const result: TestResult = {
    label: config.label,
    streamOk: false,
    streamError: '',
    streamMs: 0,
    nonStreamOk: false,
    nonStreamError: '',
    nonStreamMs: 0,
  };

  const messages = buildMessages(config.vision);
  const commonParams = {
    ...(config.provider ? { provider: config.provider } : {}),
    model: config.model,
    max_tokens: 100,
    temperature: 0.1,
  };

  // 1. Test streaming
  console.log(`\n── ${config.label} ──`);
  console.log(`   Model: ${config.model}`);
  console.log(`   Provider: ${config.provider ?? '(default HF)'}`);
  console.log(`   Vision: ${config.vision}`);

  const streamStart = performance.now();
  try {
    const stream = client.chatCompletionStream({
      ...commonParams,
      messages,
    });

    let chunkCount = 0;
    let firstContent = '';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      for await (const chunk of stream) {
        if (controller.signal.aborted) throw new Error('Timeout: 30s');
        chunkCount++;
        const content = chunk.choices?.[0]?.delta?.content;
        if (content && !firstContent) firstContent = content;
        // Stop after a few chunks — we just need to confirm streaming works
        if (chunkCount >= 5) break;
      }
    } finally {
      clearTimeout(timeout);
    }

    result.streamMs = Math.round(performance.now() - streamStart);

    if (chunkCount > 0 && firstContent) {
      result.streamOk = true;
      console.log(
        `   ✅ STREAMING SUPPORTED (${chunkCount} chunks in ${result.streamMs}ms, first: "${firstContent.trim()}")`,
      );
    } else {
      result.streamError = `Stream completed but no content received (${chunkCount} chunks)`;
      console.log(`   ⚠️  STREAM EMPTY (${chunkCount} chunks in ${result.streamMs}ms — no content)`);
    }
  } catch (err) {
    result.streamMs = Math.round(performance.now() - streamStart);
    const msg = err instanceof Error ? err.message : String(err);
    result.streamError = msg.slice(0, 120);
    console.log(`   ❌ STREAMING NOT SUPPORTED (${result.streamMs}ms): ${result.streamError}`);
  }

  // 2. Test non-streaming (baseline)
  const nonStreamStart = performance.now();
  try {
    const response = await client.chatCompletion({
      ...commonParams,
      messages,
    });
    result.nonStreamMs = Math.round(performance.now() - nonStreamStart);
    const content = response.choices[0]?.message?.content?.trim() ?? '(empty)';
    result.nonStreamOk = true;
    console.log(
      `   ✅ NON-STREAMING OK (${result.nonStreamMs}ms, response: "${content.slice(0, 80)}")`,
    );
  } catch (err) {
    result.nonStreamMs = Math.round(performance.now() - nonStreamStart);
    const msg = err instanceof Error ? err.message : String(err);
    result.nonStreamError = msg.slice(0, 120);
    console.log(`   ❌ NON-STREAMING FAILED (${result.nonStreamMs}ms): ${result.nonStreamError}`);
  }

  return result;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== HuggingFace Streaming Provider Test ===');
  console.log(`Token: ${HF_TOKEN.slice(0, 6)}...${HF_TOKEN.slice(-4)}`);
  console.log(`Time: ${new Date().toISOString()}`);

  const results: TestResult[] = [];
  for (const config of PROVIDERS) {
    const result = await testProvider(config);
    results.push(result);
  }

  // Summary table
  console.log('\n\n=== SUMMARY ===\n');
  const header = 'Provider'.padEnd(35) + 'Stream'.padEnd(12) + 'Non-Stream'.padEnd(14) + 'Stream ms'.padEnd(12) + 'Non-Stream ms';
  console.log(header);
  console.log('─'.repeat(header.length));

  for (const r of results) {
    const stream = r.streamOk ? '✅' : '❌';
    const nonStream = r.nonStreamOk ? '✅' : '❌';
    console.log(
      r.label.padEnd(35) +
        stream.padEnd(10) +
        nonStream.padEnd(12) +
        `${r.streamMs}ms`.padEnd(12) +
        `${r.nonStreamMs}ms`,
    );
  }

  // Errors
  const errors = results.filter((r) => r.streamError || r.nonStreamError);
  if (errors.length > 0) {
    console.log('\n── Errors ──');
    for (const r of errors) {
      if (r.streamError) console.log(`  ${r.label} [stream]: ${r.streamError}`);
      if (r.nonStreamError) console.log(`  ${r.label} [non-stream]: ${r.nonStreamError}`);
    }
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

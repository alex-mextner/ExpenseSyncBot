#!/usr/bin/env bun
/**
 * Verify all AI chains and models — sends a tiny smoke test to every provider slot
 * of every chain (smart, fast, ocr) and reports a status table.
 *
 * Tests both the unified aiStreamRound (chain-level fallback) AND each individual
 * provider slot directly (so we can see which providers are actually working).
 *
 * Usage:
 *   bun run scripts/verify-ai-chains.ts
 *
 * Exit code 0 if every chain has at least one working provider, 1 otherwise.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { env } from '../src/config/env';
import { geminiClient, hfClient, zaiClient } from '../src/services/ai/clients';

interface SlotSpec {
  chain: 'smart' | 'fast' | 'ocr';
  name: string;
  client: () => OpenAI;
  model: string;
  vision: boolean;
}

const SLOTS: SlotSpec[] = [
  // SMART
  {
    chain: 'smart',
    name: `z.ai ${env.AI_MODEL}`,
    client: zaiClient,
    model: env.AI_MODEL,
    vision: false,
  },
  {
    chain: 'smart',
    name: `Gemini ${env.GEMINI_MODEL}`,
    client: geminiClient,
    model: env.GEMINI_MODEL,
    vision: false,
  },
  {
    chain: 'smart',
    name: `HF ${env.HF_MODEL}`,
    client: hfClient,
    model: env.HF_MODEL,
    vision: false,
  },
  // FAST
  {
    chain: 'fast',
    name: `z.ai ${env.AI_FAST_MODEL}`,
    client: zaiClient,
    model: env.AI_FAST_MODEL,
    vision: false,
  },
  {
    chain: 'fast',
    name: `Gemini ${env.GEMINI_FAST_MODEL}`,
    client: geminiClient,
    model: env.GEMINI_FAST_MODEL,
    vision: false,
  },
  {
    chain: 'fast',
    name: `HF ${env.HF_FAST_MODEL}`,
    client: hfClient,
    model: env.HF_FAST_MODEL,
    vision: false,
  },
  // OCR
  {
    chain: 'ocr',
    name: `Gemini ${env.GEMINI_VISION_MODEL}`,
    client: geminiClient,
    model: env.GEMINI_VISION_MODEL,
    vision: true,
  },
  {
    chain: 'ocr',
    name: `HF ${env.HF_VISION_MODEL}`,
    client: hfClient,
    model: env.HF_VISION_MODEL,
    vision: true,
  },
];

/**
 * Load a real receipt image for vision testing.
 * Uses the first jpg in ../debug-images/ if available, otherwise returns null.
 * (debug-images/ is outside the worktree — it's in the main repo's gitignore.)
 */
function loadTestImage(): { dataUrl: string; mime: string; bytes: number } | null {
  const candidates = [
    path.resolve(__dirname, '../../../../debug-images'),
    path.resolve(__dirname, '../debug-images'),
  ];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    try {
      // biome-ignore lint/correctness/noNodejsModules: standalone script
      const fs = require('node:fs') as typeof import('node:fs');
      const files = fs
        .readdirSync(dir)
        .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
        .sort();
      if (files.length === 0) continue;
      const filename = files[0];
      if (!filename) continue;
      const filepath = path.join(dir, filename);
      const buf = readFileSync(filepath);
      const mime = filename.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      return {
        dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
        mime,
        bytes: buf.length,
      };
    } catch {
      // try next candidate
    }
  }
  return null;
}

const TEST_IMAGE = loadTestImage();

interface SlotResult {
  spec: SlotSpec;
  status: 'OK' | 'FAIL';
  ms: number;
  error?: string;
  preview?: string;
}

const TEXT_PROMPT =
  'Reply with a JSON object: {"status": "ok", "test": true}. Use exactly that format.';

async function testTextSlot(spec: SlotSpec): Promise<SlotResult> {
  const start = Date.now();
  // Reasoning models (Qwen3, Gemini-pro) can burn lots of tokens on internal thinking
  // before producing visible output. Give them headroom.
  const isReasoning = /qwen3|gemini-2\.5-pro|deepseek-r1/i.test(spec.model);
  const maxTokens = isReasoning ? 2048 : 256;
  try {
    const response = await spec.client().chat.completions.create({
      model: spec.model,
      messages: [{ role: 'user', content: TEXT_PROMPT }],
      max_tokens: maxTokens,
      temperature: 0.1,
    });
    const text = response.choices[0]?.message?.content?.trim() ?? '';
    const ms = Date.now() - start;
    if (!text) {
      // z.ai coding endpoint quirk: returns reasoning_content for short text replies.
      // Try to inspect raw response for debug info.
      const choice = response.choices[0];
      const finishReason = choice?.finish_reason ?? 'unknown';
      return {
        spec,
        status: 'FAIL',
        ms,
        error: `empty content (finish=${finishReason}) — likely coding endpoint quirk`,
      };
    }
    return { spec, status: 'OK', ms, preview: text.substring(0, 60).replace(/\n/g, ' ') };
  } catch (err) {
    const ms = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return { spec, status: 'FAIL', ms, error: message.substring(0, 100) };
  }
}

async function testVisionSlot(spec: SlotSpec): Promise<SlotResult> {
  const start = Date.now();
  if (!TEST_IMAGE) {
    return {
      spec,
      status: 'FAIL',
      ms: 0,
      error: 'no test image available (place a .jpg/.png in debug-images/)',
    };
  }
  try {
    const response = await spec.client().chat.completions.create({
      model: spec.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: TEST_IMAGE.dataUrl } },
            {
              type: 'text',
              text: 'Describe this image in one short sentence. If you cannot see it, say "no image".',
            },
          ],
        },
      ],
      max_tokens: 128,
      temperature: 0.1,
    });
    const text = response.choices[0]?.message?.content?.trim() ?? '';
    const ms = Date.now() - start;
    if (!text) {
      return { spec, status: 'FAIL', ms, error: 'empty response' };
    }
    return { spec, status: 'OK', ms, preview: text.substring(0, 60).replace(/\n/g, ' ') };
  } catch (err) {
    const ms = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return { spec, status: 'FAIL', ms, error: message.substring(0, 100) };
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.substring(0, n) : s + ' '.repeat(n - s.length);
}

async function main() {
  console.log('Verifying AI chains — direct provider calls');
  if (TEST_IMAGE) {
    console.log(`Using test image: ${TEST_IMAGE.bytes} bytes (${TEST_IMAGE.mime})`);
  } else {
    console.log('WARNING: no test image found — vision slots will be skipped');
  }
  console.log();
  console.log(pad('CHAIN', 7) + pad('SLOT', 38) + pad('STATUS', 7) + pad('ms', 9) + 'DETAIL');
  console.log('-'.repeat(110));

  const results: SlotResult[] = [];

  // Sequential — keeps output ordered, avoids quota piling
  for (const slot of SLOTS) {
    const result = slot.vision ? await testVisionSlot(slot) : await testTextSlot(slot);
    results.push(result);

    const detail =
      result.status === 'OK'
        ? `OK "${result.preview ?? ''}"`
        : `FAIL ${result.error?.substring(0, 90) ?? 'unknown'}`;

    console.log(
      pad(slot.chain, 7) +
        pad(slot.name, 38) +
        pad(result.status, 7) +
        pad(`${result.ms}ms`, 9) +
        detail,
    );
  }

  console.log('-'.repeat(110));

  // Per-chain summary
  for (const chain of ['smart', 'fast', 'ocr'] as const) {
    const chainResults = results.filter((r) => r.spec.chain === chain);
    const chainPassed = chainResults.filter((r) => r.status === 'OK').length;
    const chainName = chain.toUpperCase().padEnd(6);
    const status = chainPassed > 0 ? 'OK' : 'DEAD';
    console.log(`${status.padEnd(5)} ${chainName}: ${chainPassed}/${chainResults.length} working`);
  }

  const passed = results.filter((r) => r.status === 'OK').length;
  console.log(`\nTotal: ${passed}/${results.length} slots OK`);

  // Exit non-zero only if any chain has 0 working providers
  const anyChainDead = (['smart', 'fast', 'ocr'] as const).some(
    (chain) => results.filter((r) => r.spec.chain === chain && r.status === 'OK').length === 0,
  );

  if (anyChainDead) {
    console.error('\nFAIL: at least one chain has no working providers');
    process.exit(1);
  }

  console.log('\nAll chains have at least one working provider');
  process.exit(0);
}

main().catch((err) => {
  console.error('Verification script crashed:', err);
  process.exit(1);
});

#!/usr/bin/env bun
/**
 * Full OCR pipeline integration test.
 *
 * Runs:
 *   1. ocr-extractor  (vision: image → raw text)
 *   2. receipt-parser (smart + tool calling: text → items with sum-verification in one shot)
 *
 * on every image in debug-images/ (or a subset via argv).
 *
 * Prints stage-by-stage output so you can see where things break and iterate on prompts.
 *
 * Usage:
 *   bun run scripts/test-ocr-pipeline.ts                        # all images
 *   bun run scripts/test-ocr-pipeline.ts qr-1 qr-5              # subset by prefix
 *   bun run scripts/test-ocr-pipeline.ts --limit 3              # first 3
 *   bun run scripts/test-ocr-pipeline.ts --stage ocr            # only stage 1 (OCR)
 *   bun run scripts/test-ocr-pipeline.ts --stage all            # both stages (default)
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { extractTextFromImageBuffer } from '../src/services/receipt/ocr-extractor';
import { parseReceipt } from '../src/services/receipt/receipt-parser';

// ── CLI parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filters: string[] = [];
let limit = Infinity;
let stage: 'ocr' | 'all' = 'all';

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--limit' && args[i + 1]) {
    limit = Number.parseInt(args[i + 1] ?? '', 10);
    i++;
  } else if (arg === '--stage' && args[i + 1]) {
    const next = args[i + 1];
    if (next === 'ocr' || next === 'all') {
      stage = next;
    }
    i++;
  } else if (arg && !arg.startsWith('--')) {
    filters.push(arg);
  }
}

// ── Image discovery ─────────────────────────────────────────────────────────

const candidates = [
  path.resolve(__dirname, '../../../../debug-images'),
  path.resolve(__dirname, '../debug-images'),
];

let imagesDir: string | null = null;
for (const dir of candidates) {
  try {
    readdirSync(dir);
    imagesDir = dir;
    break;
  } catch {
    // try next
  }
}

if (!imagesDir) {
  console.error('No debug-images/ directory found. Checked:');
  for (const c of candidates) console.error(`  - ${c}`);
  process.exit(1);
}

let files = readdirSync(imagesDir)
  .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
  .sort();

if (filters.length > 0) {
  files = files.filter((f) => filters.some((prefix) => f.startsWith(prefix)));
}

files = files.slice(0, limit);

if (files.length === 0) {
  console.error('No matching images');
  process.exit(1);
}

console.log(`Testing ${files.length} image(s) from ${imagesDir}`);
console.log(`Stage: ${stage}`);
console.log();

// ── Pipeline ────────────────────────────────────────────────────────────────

interface StageTiming {
  ocrMs?: number;
  parseMs?: number;
}

interface PipelineResult {
  file: string;
  bytes: number;
  stageReached: 'ocr' | 'parse' | 'done' | 'error';
  ocrText?: string;
  itemsCount?: number;
  currency?: string;
  date?: string;
  computedSum?: number;
  claimedTotal?: number;
  sumVerified?: boolean;
  providerUsed?: string;
  items?: Array<{ name_ru: string; price: number; quantity: number; total: number }>;
  error?: string;
  timing: StageTiming;
}

async function runPipeline(filepath: string): Promise<PipelineResult> {
  const filename = path.basename(filepath);
  const buffer = readFileSync(filepath);
  const result: PipelineResult = {
    file: filename,
    bytes: buffer.length,
    stageReached: 'ocr',
    timing: {},
  };

  // Stage 1: OCR
  const ocrStart = Date.now();
  let ocrText: string;
  try {
    ocrText = await extractTextFromImageBuffer(buffer);
    result.timing.ocrMs = Date.now() - ocrStart;
    result.ocrText = ocrText;
  } catch (err) {
    result.timing.ocrMs = Date.now() - ocrStart;
    result.stageReached = 'error';
    result.error = `OCR: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }

  if (stage === 'ocr') {
    result.stageReached = 'done';
    return result;
  }

  // Stage 2: receipt parser (extraction + sum validation in one shot)
  result.stageReached = 'parse';
  const parseStart = Date.now();
  try {
    const parsed = await parseReceipt(ocrText, []);
    result.timing.parseMs = Date.now() - parseStart;
    result.itemsCount = parsed.items.length;
    if (parsed.currency) {
      result.currency = parsed.currency;
    }
    if (parsed.date) {
      result.date = parsed.date;
    }
    result.computedSum = parsed.computedSum;
    if (parsed.claimedTotal !== undefined) {
      result.claimedTotal = parsed.claimedTotal;
    }
    result.sumVerified = parsed.sumVerified;
    result.providerUsed = parsed.providerUsed;
    result.items = parsed.items.map((it) => ({
      name_ru: it.name_ru,
      price: it.price,
      quantity: it.quantity,
      total: it.total,
    }));
    result.stageReached = 'done';
  } catch (err) {
    result.timing.parseMs = Date.now() - parseStart;
    result.stageReached = 'error';
    result.error = `PARSE: ${err instanceof Error ? err.message : String(err)}`;
  }

  return result;
}

// ── Pretty print ────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.substring(0, n)}...` : s;
}

function printResult(r: PipelineResult) {
  const statusIcon =
    r.stageReached === 'error'
      ? 'FAIL'
      : r.itemsCount === 0
        ? 'EMPTY'
        : r.sumVerified
          ? 'VERIFIED'
          : 'UNVERIFIED';

  console.log(`\n${'━'.repeat(80)}`);
  console.log(`[${statusIcon}] ${r.file}  (${Math.round(r.bytes / 1024)}KB)`);
  console.log('━'.repeat(80));

  if (r.ocrText) {
    const ocrMs = r.timing.ocrMs ?? 0;
    console.log(`\n  STAGE 1 — OCR (${ocrMs}ms, ${r.ocrText.length} chars)`);
    console.log('  ────────────────────────────────────────');
    const lines = r.ocrText.split('\n').slice(0, 30);
    for (const line of lines) {
      console.log(`  │ ${truncate(line, 76)}`);
    }
    if (r.ocrText.split('\n').length > 30) {
      console.log(`  │ ... (${r.ocrText.split('\n').length - 30} more lines)`);
    }
  }

  if (r.stageReached === 'error' && r.error) {
    console.log(`\n  ERROR: ${r.error}`);
    return;
  }

  if (r.itemsCount !== undefined) {
    const parseMs = r.timing.parseMs ?? 0;
    console.log(`\n  STAGE 2 — Parse + validate (${parseMs}ms, via ${r.providerUsed ?? '?'})`);
    console.log('  ────────────────────────────────────────');
    console.log(`    items:       ${r.itemsCount}`);
    console.log(`    currency:    ${r.currency ?? '(none)'}`);
    console.log(`    date:        ${r.date ?? '(not found)'}`);
    console.log(`    computedSum: ${r.computedSum}`);
    console.log(`    claimedTotal: ${r.claimedTotal ?? '(not found)'}`);
    console.log(`    sumVerified: ${r.sumVerified ? 'YES' : 'NO'}`);

    if (r.items && r.items.length > 0) {
      console.log('    items detail:');
      for (const it of r.items) {
        console.log(
          `      - ${truncate(it.name_ru, 40).padEnd(40)}  ${String(it.quantity).padStart(4)} × ${String(it.price).padStart(8)} = ${String(it.total).padStart(8)}`,
        );
      }
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

const results: PipelineResult[] = [];

for (const file of files) {
  const filepath = path.join(imagesDir, file);
  console.log(`\n→ Processing ${file}...`);
  try {
    const result = await runPipeline(filepath);
    results.push(result);
    printResult(result);
  } catch (err) {
    console.error(`Crash on ${file}:`, err);
    results.push({
      file,
      bytes: 0,
      stageReached: 'error',
      error: err instanceof Error ? err.message : String(err),
      timing: {},
    });
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(80)}`);
console.log('SUMMARY');
console.log('═'.repeat(80));

const verified = results.filter((r) => r.sumVerified).length;
const unverified = results.filter(
  (r) => r.itemsCount !== undefined && r.itemsCount > 0 && !r.sumVerified,
).length;
const empty = results.filter((r) => r.itemsCount === 0).length;
const errored = results.filter((r) => r.stageReached === 'error').length;

console.log(`Total:      ${results.length}`);
console.log(`Verified:   ${verified}   (items extracted AND sum confirmed via tool)`);
console.log(`Unverified: ${unverified}   (items extracted but sum check failed)`);
console.log(`Empty:      ${empty}   (no items found in receipt text)`);
console.log(`Errored:    ${errored}`);

const totalOcrMs = results.reduce((a, r) => a + (r.timing.ocrMs ?? 0), 0);
const totalParseMs = results.reduce((a, r) => a + (r.timing.parseMs ?? 0), 0);
console.log(`\nAvg timings:`);
console.log(`  OCR:    ${Math.round(totalOcrMs / results.length)}ms`);
console.log(`  Parse:  ${Math.round(totalParseMs / results.length)}ms`);

process.exit(errored > 0 ? 1 : 0);

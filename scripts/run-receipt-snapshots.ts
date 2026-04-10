#!/usr/bin/env bun
/**
 * Receipt OCR snapshot regression tests.
 *
 * ⚠ INTENTIONALLY NOT PART OF `bun run test` ⚠
 *
 * This script hits real AI providers (z.ai, Gemini, HF) and costs real tokens.
 * It's opt-in — run manually before releasing prompt/model changes:
 *
 *     bun run scripts/run-receipt-snapshots.ts
 *
 * The script runs the full pipeline (ocr-extractor → parseReceipt) on every
 * fixture in tests/fixtures/receipts/ and checks the result against
 * tests/fixtures/receipts/EXPECTED.json. Fails (exit 1) on any mismatch.
 *
 * Use when:
 *  - Modifying the OCR or parseReceipt prompt
 *  - Changing which models live in SMART/OCR chains
 *  - After adding a fixture (to capture the baseline)
 *
 * The LLM output is inherently noisy, so matching rules are tolerant:
 *  - itemsCount: exact
 *  - currency + date: exact
 *  - computedSum, claimedTotal: within 1%
 *  - sumVerified: exact
 *  - expectedItemNames: each substring must appear in at least one item name (case-insensitive)
 *
 * To add a new fixture:
 *  1. Copy the image into tests/fixtures/receipts/<descriptive-name>.jpg
 *  2. Run this script to see what the pipeline produces
 *  3. Add an entry to EXPECTED.json
 *  4. Re-run to confirm it passes
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { extractTextFromImageBuffer } from '../src/services/receipt/ocr-extractor';
import { parseReceipt } from '../src/services/receipt/receipt-parser';

const FIXTURES_DIR = path.resolve(__dirname, '../tests/fixtures/receipts');
const EXPECTED_PATH = path.join(FIXTURES_DIR, 'EXPECTED.json');
const TOLERANCE = 0.01; // 1%

interface FixtureExpectation {
  itemsCount: number;
  currency: string;
  claimedTotal?: number;
  computedSum: number;
  sumVerified: boolean;
  date?: string;
  expectedItemNames?: string[];
}

interface ExpectedFile {
  fixtures: Record<string, FixtureExpectation>;
}

const expected: ExpectedFile = JSON.parse(readFileSync(EXPECTED_PATH, 'utf-8'));

interface FailureReport {
  fixture: string;
  field: string;
  expected: unknown;
  actual: unknown;
}

const failures: FailureReport[] = [];

function assertEqual(fixture: string, field: string, expectedValue: unknown, actual: unknown) {
  if (expectedValue !== actual) {
    failures.push({ fixture, field, expected: expectedValue, actual });
  }
}

function assertCloseTo(
  fixture: string,
  field: string,
  expectedValue: number,
  actual: number,
  tolerance: number,
) {
  const diff = Math.abs(expectedValue - actual);
  const allowed = Math.max(expectedValue * tolerance, 0.5);
  if (diff > allowed) {
    failures.push({
      fixture,
      field,
      expected: `${expectedValue} (±${tolerance * 100}%)`,
      actual,
    });
  }
}

function assertItemNamesContain(
  fixture: string,
  expectedSubstrings: string[],
  itemNames: string[],
) {
  const haystack = itemNames.join(' | ').toLowerCase();
  for (const substring of expectedSubstrings) {
    if (!haystack.includes(substring.toLowerCase())) {
      failures.push({
        fixture,
        field: 'expectedItemNames',
        expected: `contains "${substring}"`,
        actual: itemNames,
      });
    }
  }
}

async function runFixture(filename: string, spec: FixtureExpectation): Promise<void> {
  const filepath = path.join(FIXTURES_DIR, filename);
  console.log(`\n→ ${filename}`);

  const buffer = readFileSync(filepath);
  const ocrStart = Date.now();
  const ocrText = await extractTextFromImageBuffer(buffer);
  const ocrMs = Date.now() - ocrStart;

  console.log(`  OCR:   ${ocrMs}ms, ${ocrText.length} chars`);

  const parseStart = Date.now();
  const parsed = await parseReceipt(ocrText, []);
  const parseMs = Date.now() - parseStart;

  console.log(
    `  Parse: ${parseMs}ms, ${parsed.items.length} items, sum=${parsed.computedSum}, date=${parsed.date ?? '(none)'}, verified=${parsed.sumVerified}, via ${parsed.providerUsed}`,
  );

  // Hard checks
  assertEqual(filename, 'itemsCount', spec.itemsCount, parsed.items.length);
  assertEqual(filename, 'currency', spec.currency, parsed.currency);
  assertEqual(filename, 'sumVerified', spec.sumVerified, parsed.sumVerified);
  if (spec.date !== undefined) {
    assertEqual(filename, 'date', spec.date, parsed.date);
  }

  // Tolerant numeric checks
  assertCloseTo(filename, 'computedSum', spec.computedSum, parsed.computedSum, TOLERANCE);
  if (spec.claimedTotal !== undefined && parsed.claimedTotal !== undefined) {
    assertCloseTo(filename, 'claimedTotal', spec.claimedTotal, parsed.claimedTotal, TOLERANCE);
  }

  // Loose item name check
  if (spec.expectedItemNames) {
    assertItemNamesContain(
      filename,
      spec.expectedItemNames,
      parsed.items.map((it) => it.name_ru),
    );
  }
}

async function main() {
  const files = readdirSync(FIXTURES_DIR).filter((f) => /\.(jpg|jpeg|png)$/i.test(f));
  if (files.length === 0) {
    console.error('No fixture images found in tests/fixtures/receipts/');
    process.exit(1);
  }

  console.log(`Running ${files.length} receipt snapshot test(s)...`);

  for (const filename of files) {
    const spec = expected.fixtures[filename];
    if (!spec) {
      console.warn(`  [SKIP] ${filename} — no entry in EXPECTED.json`);
      continue;
    }
    try {
      await runFixture(filename, spec);
    } catch (err) {
      console.error(`  [CRASH] ${filename}:`, err);
      failures.push({
        fixture: filename,
        field: '(crash)',
        expected: 'clean run',
        actual: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log(`\n${'═'.repeat(80)}`);
  if (failures.length === 0) {
    console.log(`OK — all snapshots match`);
    process.exit(0);
  }

  console.log(`FAIL — ${failures.length} mismatch(es):`);
  for (const f of failures) {
    console.log(`  ${f.fixture}  ${f.field}`);
    console.log(`    expected: ${JSON.stringify(f.expected)}`);
    console.log(`    actual:   ${JSON.stringify(f.actual)}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('Snapshot runner crashed:', err);
  process.exit(1);
});

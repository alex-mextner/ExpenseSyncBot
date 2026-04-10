#!/usr/bin/env bun
/** Quick OCR dump for one image — full output with no truncation. */
import { readFileSync } from 'node:fs';
import { extractTextFromImageBuffer } from '../src/services/receipt/ocr-extractor';

const filepath = process.argv[2];
if (!filepath) {
  console.error('Usage: bun run scripts/dump-ocr.ts <path>');
  process.exit(1);
}

const buf = readFileSync(filepath);
console.log(`Image: ${filepath} (${buf.length} bytes)`);
console.log('---');

const text = await extractTextFromImageBuffer(buf);
console.log(`Extracted ${text.length} chars:`);
console.log('---');
console.log(text);

/** OCR extractor — sends receipt images to a vision model and extracts text */
import { createLogger } from '../../utils/logger.ts';
import { aiStreamRound } from '../ai/streaming';

const logger = createLogger('ocr-extractor');

// A real receipt rarely exceeds ~3000 chars. Output longer than this is almost
// always a hallucination (reasoning model looping on repeating tokens).
const MAX_REASONABLE_OCR_CHARS = 8000;

const OCR_PROMPT = `You are a strict OCR engine. Extract the PRINTED TEXT from this receipt image, exactly as it appears.

RULES (critical, no exceptions):
1. Output ONLY the printed text. Do NOT add any preamble, introduction, or explanation. Do NOT write "Here is the text...", "The image contains...", or any similar wrapper.
2. Do NOT decode, follow, or interpret QR codes, barcodes, or URLs. If a QR or barcode is present, write the literal marker "[QR]" or "[BARCODE]" and move on. Never output contents extracted from a QR.
3. Preserve the original line order and grouping.
4. Do NOT translate anything. Keep the original language and script (Cyrillic, Latin, etc.) as-is.
5. Include: store name, date, items with prices, quantities, subtotals, totals, taxes, fiscal info, any other printed text visible.
6. If there is no printed text at all (blank image, unreadable), output only the literal string: NO_TEXT

Respond with the raw extracted text only. Nothing before, nothing after.`;

/**
 * Detect runaway output from a reasoning model — when the same short block
 * keeps repeating for most of the response. Common failure mode on HF Qwen3.
 */
function looksLikeRepetitionLoop(text: string): boolean {
  if (text.length < 1000) return false;
  // Take a 200-char window from the middle and count how many times it appears
  const mid = Math.floor(text.length / 2);
  const sample = text.substring(mid, mid + 100);
  if (!sample.trim()) return false;
  const occurrences = text.split(sample).length - 1;
  return occurrences > 5;
}

/** Sanitize suspicious OCR output — cap length, strip repeats. */
function sanitizeOcrText(text: string, providerUsed: string): string {
  if (looksLikeRepetitionLoop(text)) {
    logger.warn(
      `[OCR] Detected repetition loop from ${providerUsed} (${text.length} chars) — treating as garbage`,
    );
    return '';
  }
  if (text.length > MAX_REASONABLE_OCR_CHARS) {
    logger.warn(
      `[OCR] Output from ${providerUsed} exceeded sanity limit (${text.length} chars) — truncating to ${MAX_REASONABLE_OCR_CHARS}`,
    );
    return text.substring(0, MAX_REASONABLE_OCR_CHARS);
  }
  return text;
}

/**
 * Extract text from receipt image using vision model — fully in-memory via base64 data URL.
 * No disk writes, no temp files.
 */
export async function extractTextFromImageBuffer(imageBuffer: Buffer): Promise<string> {
  logger.info('[OCR] Extracting text from image buffer using vision model (in-memory)');

  const dataUrl = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;

  const { text, providerUsed } = await aiStreamRound({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: OCR_PROMPT },
        ],
      },
    ],
    maxTokens: 2000,
    temperature: 0.1,
    chain: 'ocr',
  });

  const sanitized = sanitizeOcrText(text, providerUsed);

  logger.info(
    `[OCR] Extracted ${sanitized.length} chars via ${providerUsed}: ${sanitized.substring(0, 200)}...`,
  );
  return sanitized;
}

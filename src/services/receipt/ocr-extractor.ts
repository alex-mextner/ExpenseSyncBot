/** OCR extractor — sends receipt images to a vision model and extracts text */
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env';
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
 * Start periodic cleanup of old temp images
 * Runs every 5 minutes and deletes files older than 5 minutes
 */
export function startTempImageCleanup(): void {
  const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
  const MAX_AGE = 5 * 60 * 1000; // 5 minutes

  setInterval(async () => {
    try {
      const tempDir = path.join(process.cwd(), 'temp-images');

      let files: string[];
      try {
        files = await readdir(tempDir);
      } catch {
        // Directory doesn't exist, skip cleanup
        return;
      }
      const now = Date.now();
      let deletedCount = 0;

      for (const file of files) {
        const filepath = path.join(tempDir, file);
        const stats = await stat(filepath);
        const age = now - stats.mtimeMs;

        if (age > MAX_AGE) {
          try {
            await unlink(filepath);
            deletedCount++;
          } catch (error) {
            logger.error({ err: error }, `[OCR_CLEANUP] Failed to delete old file ${file}`);
          }
        }
      }

      if (deletedCount > 0) {
        logger.info(`[OCR_CLEANUP] Deleted ${deletedCount} old temp image(s)`);
      }
    } catch (error) {
      logger.error({ err: error }, '[OCR_CLEANUP] Error during cleanup');
    }
  }, CLEANUP_INTERVAL);

  logger.info('[OCR_CLEANUP] Started periodic temp image cleanup (every 5 minutes)');
}

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

/**
 * Extract text from receipt image using vision model (temp file URL variant).
 */
export async function extractTextFromImage(imageBuffer: Buffer): Promise<string> {
  logger.info('[OCR] Extracting text from image using vision model');

  // Create temp-images directory if doesn't exist
  const tempDir = path.join(process.cwd(), 'temp-images');
  await mkdir(tempDir, { recursive: true });

  const timestamp = Date.now();
  const filename = `ocr-${timestamp}.jpg`;
  const filepath = path.join(tempDir, filename);

  try {
    await Bun.write(filepath, imageBuffer);
    logger.info(`[OCR] Saved temp image: ${filepath}`);

    const baseUrl =
      env.GOOGLE_REDIRECT_URI?.replace('/callback', '') ||
      `http://localhost:${env.OAUTH_SERVER_PORT}`;
    const imageUrl = `${baseUrl}/temp-images/${filename}`;

    logger.info(`[OCR] Image URL: ${imageUrl}`);

    const { text, providerUsed } = await aiStreamRound({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageUrl } },
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

    // Temp images are cleaned up by startTempImageCleanup() periodic task
    return sanitized;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: errorMessage }, '[OCR] Failed to extract text from image');
    throw new Error(`OCR extraction failed: ${errorMessage}`);
  }
}

/** OCR extractor — sends receipt images to a vision model and extracts text */
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env';
import { createLogger } from '../../utils/logger.ts';
import { aiComplete } from '../ai/completion';

const logger = createLogger('ocr-extractor');

const OCR_PROMPT = `Extract ALL text from this receipt image. Include:
- Store name
- Date and time
- All items with their names and prices
- Quantities
- Subtotals and totals
- Any other visible text

Return the text exactly as it appears on the receipt, preserving the structure and order.`;

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
 * Extract text from receipt image using vision model — fully in-memory via base64 data URL.
 * No disk writes, no temp files.
 */
export async function extractTextFromImageBuffer(imageBuffer: Buffer): Promise<string> {
  logger.info('[OCR] Extracting text from image buffer using vision model (in-memory)');

  const dataUrl = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;

  const { text } = await aiComplete({
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
    vision: true,
  });

  logger.info(`[OCR] Extracted ${text.length} chars: ${text.substring(0, 200)}...`);
  return text;
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

    const { text } = await aiComplete({
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
      vision: true,
    });

    logger.info(`[OCR] Extracted ${text.length} chars: ${text.substring(0, 200)}...`);

    // Temp images are cleaned up by startTempImageCleanup() periodic task
    return text;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: errorMessage }, '[OCR] Failed to extract text from image');
    throw new Error(`OCR extraction failed: ${errorMessage}`);
  }
}

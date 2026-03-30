/** OCR extractor — sends receipt images to Hugging Face vision model and extracts text */
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { InferenceClient } from '@huggingface/inference';
import { env } from '../../config/env';
import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('ocr-extractor');

const client = new InferenceClient(env.HF_TOKEN);

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
 * Extract text from receipt image using Qwen Vision model
 * @param imageBuffer - Image buffer (JPEG/PNG)
 * @returns Extracted text from receipt
 */
export async function extractTextFromImage(imageBuffer: Buffer): Promise<string> {
  logger.info(`[OCR] Attempting to extract text from image using Qwen Vision model`);

  // Create temp-images directory if doesn't exist
  const tempDir = path.join(process.cwd(), 'temp-images');
  await mkdir(tempDir, { recursive: true });

  // Save image to temp directory with unique filename
  const timestamp = Date.now();
  const filename = `ocr-${timestamp}.jpg`;
  const filepath = path.join(tempDir, filename);

  try {
    await Bun.write(filepath, imageBuffer);
    logger.info(`[OCR] Saved temp image: ${filepath}`);

    // Get base URL from environment or use localhost
    const baseUrl =
      env.GOOGLE_REDIRECT_URI?.replace('/callback', '') ||
      `http://localhost:${env.OAUTH_SERVER_PORT}`;
    const imageUrl = `${baseUrl}/temp-images/${filename}`;

    logger.info(`[OCR] Image URL: ${imageUrl}`);

    // Call Qwen Vision model with URL
    const response = await client.chatCompletion({
      model: 'Qwen/Qwen2.5-VL-72B-Instruct',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: imageUrl,
              },
            },
            {
              type: 'text',
              text: `Extract ALL text from this receipt image. Include:
- Store name
- Date and time
- All items with their names and prices
- Quantities
- Subtotals and totals
- Any other visible text

Return the text exactly as it appears on the receipt, preserving the structure and order.`,
            },
          ],
        },
      ],
      max_tokens: 2000,
      temperature: 0.1,
    });

    const extractedText = response.choices[0]?.message?.content?.trim();

    if (!extractedText) {
      throw new Error('No text extracted from image');
    }

    logger.info(
      `[OCR] Successfully extracted text (${extractedText.length} chars): ${extractedText.substring(0, 200)}...`,
    );

    // Temp images are cleaned up by startTempImageCleanup() periodic task

    return extractedText;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: errorMessage }, '[OCR] Failed to extract text from image');

    // Temp images are cleaned up by startTempImageCleanup() periodic task

    throw new Error(`OCR extraction failed: ${errorMessage}`);
  }
}

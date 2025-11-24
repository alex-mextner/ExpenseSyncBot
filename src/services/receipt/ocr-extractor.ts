import { InferenceClient } from "@huggingface/inference";
import { env } from "../../config/env";

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
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const tempDir = path.join(process.cwd(), 'temp-images');

      // Check if directory exists
      try {
        await fs.access(tempDir);
      } catch {
        // Directory doesn't exist, skip cleanup
        return;
      }

      const files = await fs.readdir(tempDir);
      const now = Date.now();
      let deletedCount = 0;

      for (const file of files) {
        const filepath = path.join(tempDir, file);
        const stats = await fs.stat(filepath);
        const age = now - stats.mtimeMs;

        if (age > MAX_AGE) {
          try {
            await fs.unlink(filepath);
            deletedCount++;
          } catch (error) {
            console.error(`[OCR_CLEANUP] Failed to delete old file ${file}:`, error);
          }
        }
      }

      if (deletedCount > 0) {
        console.log(`[OCR_CLEANUP] Deleted ${deletedCount} old temp image(s)`);
      }
    } catch (error) {
      console.error('[OCR_CLEANUP] Error during cleanup:', error);
    }
  }, CLEANUP_INTERVAL);

  console.log('[OCR_CLEANUP] Started periodic temp image cleanup (every 5 minutes)');
}

/**
 * Extract text from receipt image using Qwen Vision model
 * @param imageBuffer - Image buffer (JPEG/PNG)
 * @returns Extracted text from receipt
 */
export async function extractTextFromImage(
  imageBuffer: Buffer
): Promise<string> {
  console.log(`[OCR] Attempting to extract text from image using Qwen Vision model`);

  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  // Create temp-images directory if doesn't exist
  const tempDir = path.join(process.cwd(), 'temp-images');
  await fs.mkdir(tempDir, { recursive: true });

  // Save image to temp directory with unique filename
  const timestamp = Date.now();
  const filename = `ocr-${timestamp}.jpg`;
  const filepath = path.join(tempDir, filename);

  try {
    await fs.writeFile(filepath, imageBuffer);
    console.log(`[OCR] Saved temp image: ${filepath}`);

    // Get base URL from environment or use localhost
    const baseUrl = env.GOOGLE_REDIRECT_URI?.replace('/callback', '') || `http://localhost:${env.OAUTH_SERVER_PORT}`;
    const imageUrl = `${baseUrl}/temp-images/${filename}`;

    console.log(`[OCR] Image URL: ${imageUrl}`);

    // Call Qwen Vision model with URL
    const response = await client.chatCompletion({
      model: "Qwen/Qwen2.5-VL-72B-Instruct",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: imageUrl,
              },
            },
            {
              type: "text",
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
      throw new Error("No text extracted from image");
    }

    console.log(
      `[OCR] Successfully extracted text (${extractedText.length} chars): ${extractedText.substring(0, 200)}...`
    );

    // TEMP: Cleanup disabled for debugging
    // Delay cleanup to allow Hugging Face API to download the image
    // (API returns before actually downloading the file)
    // setTimeout(async () => {
    //   try {
    //     await fs.unlink(filepath);
    //     console.log(`[OCR] Cleaned up temp image: ${filepath}`);
    //   } catch (cleanupError) {
    //     console.error(`[OCR] Failed to cleanup temp image:`, cleanupError);
    //   }
    // }, 30000); // 30 seconds delay

    console.log(`[OCR] Temp image kept for debugging: ${filepath}`);

    return extractedText;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(`[OCR] Failed to extract text from image:`, errorMessage);

    // TEMP: Cleanup disabled for debugging
    // Cleanup on error (no delay needed)
    // try {
    //   await fs.unlink(filepath);
    //   console.log(`[OCR] Cleaned up temp image after error: ${filepath}`);
    // } catch (cleanupError) {
    //   console.error(`[OCR] Failed to cleanup temp image:`, cleanupError);
    // }

    console.log(`[OCR] Temp image kept after error for debugging: ${filepath}`);

    throw new Error(`OCR extraction failed: ${errorMessage}`);
  }
}

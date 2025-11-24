import { InferenceClient } from "@huggingface/inference";
import { env } from "../../config/env";

const client = new InferenceClient(env.HF_TOKEN);

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

    return extractedText;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(`[OCR] Failed to extract text from image:`, errorMessage);
    throw new Error(`OCR extraction failed: ${errorMessage}`);
  } finally {
    // Cleanup temp file
    try {
      await fs.unlink(filepath);
      console.log(`[OCR] Cleaned up temp image: ${filepath}`);
    } catch (cleanupError) {
      console.error(`[OCR] Failed to cleanup temp image:`, cleanupError);
    }
  }
}

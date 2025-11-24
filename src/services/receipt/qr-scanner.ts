import type { Image } from 'qr';
import decodeQR, { type DecodeOpts, type FinderPoints } from 'qr/decode.js';
import sharp from 'sharp';

/**
 * Scan QR code from image buffer
 * @param imageBuffer - Image buffer (from Telegram file download)
 * @returns QR code data or null if no QR found
 */
export async function scanQRFromImage(imageBuffer: Buffer): Promise<string | null> {
  console.log(`[QR_SCANNER] Processing image buffer: ${imageBuffer.length} bytes`);

  // Try multiple image processing variants
  const variants = [
    // 1. Small with high contrast and sharpening
    {
      name: '500px+sharp+contrast',
      process: (img: sharp.Sharp) => img
        .resize(500, 500, { fit: 'inside', withoutEnlargement: true })
        .sharpen()
        .normalize()
        .grayscale()
    },
    // 2. Medium with sharpening
    {
      name: '800px+sharp',
      process: (img: sharp.Sharp) => img
        .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
        .sharpen()
        .normalize()
    },
    // 3. Original with sharpening
    {
      name: 'original+sharp',
      process: (img: sharp.Sharp) => img
        .sharpen()
        .normalize()
    },
    // 4. Medium size basic
    {
      name: '800px',
      process: (img: sharp.Sharp) => img.resize(800, 800, { fit: 'inside', withoutEnlargement: true })
    },
    // 5. Small size basic
    {
      name: '500px',
      process: (img: sharp.Sharp) => img.resize(500, 500, { fit: 'inside', withoutEnlargement: true })
    },
    // 6. Extreme contrast
    {
      name: 'extreme-contrast',
      process: (img: sharp.Sharp) => img
        .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
        .grayscale()
        .normalize()
        .linear(1.5, -(128 * 0.5)) // Increase contrast
    },
    // 7. Original size
    {
      name: 'original',
      process: (img: sharp.Sharp) => img
    },
  ];

  for (const variant of variants) {
    try {
      console.log(`[QR_SCANNER] Trying variant: ${variant.name}`);

      // Process image
      const { data, info } = await variant.process(sharp(imageBuffer))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      console.log(`[QR_SCANNER] Image converted: ${info.width}x${info.height}, ${info.channels} channels`);

      // Create Uint8ClampedArray for qr library
      const imageData = new Uint8ClampedArray(data.buffer);

      // Scan for QR code with debug callbacks
      let patternsDetected = false;
      let qrExtracted = false;

      const opts: DecodeOpts = {
        pointsOnDetect: (points: FinderPoints) => {
          patternsDetected = true;
          console.log(`[QR_SCANNER] 🎯 Patterns detected at:`, points.map(p => `(${p.x},${p.y})`).join(', '));
        },
        imageOnDetect: (img: Image) => {
          qrExtracted = true;
          console.log(`[QR_SCANNER] 📦 QR image extracted: ${img.width}x${img.height}`);
        },
      };

      const qrData = decodeQR(
        {
          width: info.width,
          height: info.height,
          data: imageData,
        },
        opts
      );

      if (qrData) {
        console.log(`[QR_SCANNER] ✅ QR code found with variant: ${variant.name}! Length: ${qrData.length} chars`);
        console.log(`[QR_SCANNER] QR data preview: ${qrData.substring(0, 200)}${qrData.length > 200 ? '...' : ''}`);
        return qrData;
      }

      // Enhanced error reporting
      if (patternsDetected) {
        console.log(`[QR_SCANNER] ⚠️ Patterns detected but decoding failed (${variant.name})`);
      } else {
        console.log(`[QR_SCANNER] ❌ No QR patterns found (${variant.name})`);
      }

      if (qrExtracted) {
        console.log(`[QR_SCANNER] ⚠️ QR image extracted but data decoding failed (${variant.name})`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(`[QR_SCANNER] Variant ${variant.name} failed: ${errorMsg}`);
      // Continue to next variant
    }
  }

  console.log(`[QR_SCANNER] ❌ All local variants failed, trying external API...`);

  // Try external API as last resort
  try {
    const apiResult = await scanQRWithExternalAPI(imageBuffer);
    if (apiResult) {
      console.log(`[QR_SCANNER] ✅ QR code found with external API! Length: ${apiResult.length} chars`);
      console.log(`[QR_SCANNER] QR data preview: ${apiResult.substring(0, 200)}${apiResult.length > 200 ? '...' : ''}`);
      return apiResult;
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log(`[QR_SCANNER] External API failed: ${errorMsg}`);
  }

  console.log(`[QR_SCANNER] ❌ No QR code found after trying all ${variants.length} local variants + external API`);
  return null;
}

/**
 * Scan QR code using external API (goqr.me)
 */
async function scanQRWithExternalAPI(imageBuffer: Buffer): Promise<string | null> {
  console.log(`[QR_SCANNER] Sending ${imageBuffer.length} bytes to external API...`);

  // Use File constructor instead of Blob for better compatibility
  const file = new File([imageBuffer], 'qr.jpg', { type: 'image/jpeg' });

  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch('https://api.qrserver.com/v1/read-qr-code/', {
    method: 'POST',
    body: formData,
  });

  console.log(`[QR_SCANNER] API response status: ${response.status} ${response.statusText}`);

  if (!response.ok) {
    throw new Error(`API request failed: ${response.statusText}`);
  }

  const result = await response.json() as Array<{ type: string; symbol: Array<{ data: string | null; error: string | null }> }>;

  console.log(`[QR_SCANNER] API response:`, JSON.stringify(result, null, 2));

  if (!result || result.length === 0) {
    console.log(`[QR_SCANNER] API returned empty result array`);
    return null;
  }

  const firstResult = result[0];
  if (!firstResult.symbol || firstResult.symbol.length === 0) {
    console.log(`[QR_SCANNER] API result has no symbols`);
    return null;
  }

  const symbolData = firstResult.symbol[0];
  if (symbolData.error) {
    console.log(`[QR_SCANNER] External API error: ${symbolData.error}`);
    console.log(`[QR_SCANNER] Full symbol data:`, JSON.stringify(symbolData, null, 2));
    return null;
  }

  return symbolData.data || null;
}

/**
 * Check if string is a URL
 */
export function isURL(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

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

  console.log(`[QR_SCANNER] ❌ No QR code found after trying all ${variants.length} variants`);
  return null;
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

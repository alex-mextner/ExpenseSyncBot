import type { Image } from 'qr';
import decodeQR, { type DecodeOpts, type FinderPoints } from 'qr/decode.js';
import sharp from 'sharp';

/**
 * Scan QR code from image buffer
 * @param imageBuffer - Image buffer (from Telegram file download)
 * @returns QR code data or null if no QR found
 */
export async function scanQRFromImage(imageBuffer: Buffer): Promise<string | null> {
  try {
    console.log(`[QR_SCANNER] Processing image buffer: ${imageBuffer.length} bytes`);

    // Convert image to raw RGBA pixels using sharp
    const { data, info } = await sharp(imageBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    console.log(`[QR_SCANNER] Image converted: ${info.width}x${info.height}, ${info.channels} channels, ${data.length} bytes`);

    // Create Uint8ClampedArray for @paulmillr/qr
    const imageData = new Uint8ClampedArray(data.buffer);

    console.log(`[QR_SCANNER] Scanning for QR code in ${info.width}x${info.height} image...`);

    // Scan for QR code using @paulmillr/qr with debug callbacks
    let patternsDetected = false;
    let qrExtracted = false;

    const opts: DecodeOpts = {
      // Callback when finder patterns are detected (3 finder + 1 alignment)
      pointsOnDetect: (points: FinderPoints) => {
        patternsDetected = true;
        console.log(`[QR_SCANNER] 🎯 Patterns detected at:`, points.map(p => `(${p.x},${p.y})`).join(', '));
      },
      // Callback when QR image is extracted
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
      console.log(`[QR_SCANNER] ✅ QR code found! Length: ${qrData.length} chars`);
      console.log(`[QR_SCANNER] QR data preview: ${qrData.substring(0, 200)}${qrData.length > 200 ? '...' : ''}`);
      return qrData;
    }

    // Enhanced error reporting
    if (patternsDetected) {
      console.log(`[QR_SCANNER] ⚠️ Patterns detected but decoding failed`);
    } else {
      console.log(`[QR_SCANNER] ❌ No QR patterns found in image`);
    }

    if (qrExtracted) {
      console.log(`[QR_SCANNER] ⚠️ QR image extracted but data decoding failed`);
    }

    return null;
  } catch (error) {
    console.error('[QR_SCANNER] Error scanning QR code:', error);
    return null;
  }
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

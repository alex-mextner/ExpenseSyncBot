import jsQR from 'jsqr';
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

    // Create Uint8ClampedArray for jsQR
    const imageData = new Uint8ClampedArray(data.buffer);

    console.log(`[QR_SCANNER] Scanning for QR code in ${info.width}x${info.height} image...`);

    // Scan for QR code
    const qrCode = jsQR(imageData, info.width, info.height);

    if (qrCode && qrCode.data) {
      console.log(`[QR_SCANNER] ✅ QR code found! Length: ${qrCode.data.length} chars`);
      console.log(`[QR_SCANNER] QR data preview: ${qrCode.data.substring(0, 200)}${qrCode.data.length > 200 ? '...' : ''}`);
      console.log(`[QR_SCANNER] QR location: (${qrCode.location.topLeftCorner.x}, ${qrCode.location.topLeftCorner.y})`);
      return qrCode.data;
    }

    console.log(`[QR_SCANNER] ❌ No QR code found in image`);
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

import jsQR from 'jsqr';
import sharp from 'sharp';

/**
 * Scan QR code from image buffer
 * @param imageBuffer - Image buffer (from Telegram file download)
 * @returns QR code data or null if no QR found
 */
export async function scanQRFromImage(imageBuffer: Buffer): Promise<string | null> {
  try {
    // Convert image to raw RGBA pixels using sharp
    const { data, info } = await sharp(imageBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Create Uint8ClampedArray for jsQR
    const imageData = new Uint8ClampedArray(data.buffer);

    // Scan for QR code
    const qrCode = jsQR(imageData, info.width, info.height);

    if (qrCode && qrCode.data) {
      return qrCode.data;
    }

    return null;
  } catch (error) {
    console.error('Error scanning QR code:', error);
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

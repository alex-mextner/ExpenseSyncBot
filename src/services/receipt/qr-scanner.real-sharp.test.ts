// scanQRFromImage end to end with the REAL sharp build (qr-scanner.test.ts mocks it out).
// Guards sharp upgrades: the variant pipelines must still hand qr/decode.js an RGBA raw buffer
// it can read, and a clean QR code must decode locally without the external API fallback.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { encodeQR } from 'qr';
import sharp from 'sharp';
import { mockFetchError } from '../../test-utils/mocks/fetch';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

const { scanQRFromImage } = await import('./qr-scanner');

/** Render a QR code as a JPEG photo-like buffer: 8 px per module, 4-module quiet zone. */
async function qrJpeg(text: string): Promise<Buffer> {
  const modules = encodeQR(text, 'raw');
  const scale = 8;
  const quiet = 4;
  const side = (modules.length + quiet * 2) * scale;
  const pixels = Buffer.alloc(side * side * 3, 255);
  modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const offset = (((y + quiet) * scale + dy) * side + (x + quiet) * scale + dx) * 3;
          pixels.fill(0, offset, offset + 3);
        }
      }
    });
  });
  return sharp(pixels, { raw: { width: side, height: side, channels: 3 } })
    .jpeg({ quality: 90 })
    .toBuffer();
}

describe('scanQRFromImage with real sharp', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof mockFetchError>;

  beforeEach(() => {
    fetchMock = mockFetchError('external QR API must not be called');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('decodes a receipt QR payload locally', async () => {
    const payload = 'https://suf.purs.gov.rs/v/?vl=A1B2C3D4E5F6G7H8I9J0';
    const result = await scanQRFromImage(await qrJpeg(payload));
    expect(result).toBe(payload);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
    expect(logMock.warn).not.toHaveBeenCalled();
  });
});

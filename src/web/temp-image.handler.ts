// Serves temporary images for OCR processing from the temp-images/ directory
import * as path from 'node:path';
import { createLogger } from '../utils/logger.ts';

const logger = createLogger('temp-image');

/**
 * Handle temporary image serving for OCR
 */
export async function handleTempImage(url: URL): Promise<Response> {
  const filename = url.pathname.split('/temp-images/')[1];

  if (!filename) {
    return new Response('Not Found', { status: 404 });
  }

  const tempDir = path.resolve(process.cwd(), 'temp-images');

  // Decode percent-encoding before resolving — %2e%2e%2f and similar bypass path.resolve without this
  let decodedFilename: string;
  try {
    decodedFilename = decodeURIComponent(filename);
  } catch {
    return new Response('Forbidden', { status: 403 });
  }

  const filepath = path.resolve(tempDir, decodedFilename);

  // Block path traversal — resolved path must stay within tempDir
  if (!filepath.startsWith(tempDir + path.sep) && filepath !== tempDir) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const file = Bun.file(filepath);

    if (!(await file.exists())) {
      return new Response('Not Found', { status: 404 });
    }

    return new Response(file, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
  } catch (error) {
    logger.error({ err: error }, '[TEMP_IMAGE] Error serving image');
    return new Response('Internal Server Error', { status: 500 });
  }
}

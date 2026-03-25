// Tests for path traversal protection in the /temp-images/ endpoint

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleTempImage } from './temp-image.handler';

const TEMP_DIR = path.join(process.cwd(), 'temp-images');
const TEST_IMAGE = path.join(TEMP_DIR, 'test-fixture.jpg');

beforeAll(() => {
  // Create temp-images dir and a valid fixture file for the 200 test
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.writeFileSync(TEST_IMAGE, Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // JPEG magic bytes
});

afterAll(() => {
  // Clean up fixture
  if (fs.existsSync(TEST_IMAGE)) {
    fs.unlinkSync(TEST_IMAGE);
  }
});

describe('handleTempImage — path traversal protection', () => {
  // The URL constructor normalizes `../../../.env` to `/.env` (no /temp-images/ prefix),
  // so the router never calls handleTempImage — that traversal is blocked at the routing layer.
  // The handler must block percent-encoded variants that survive URL parsing.

  it('blocks %2e%2e%2f (lowercase) URL-encoded traversal with 403', async () => {
    const url = new URL('http://localhost/temp-images/%2e%2e%2f.env');
    const res = await handleTempImage(url);
    expect(res.status).toBe(403);
  });

  it('blocks ..%2F..%2F (mixed) URL-encoded traversal with 403', async () => {
    const url = new URL('http://localhost/temp-images/..%2F..%2F.env');
    const res = await handleTempImage(url);
    expect(res.status).toBe(403);
  });

  it('blocks %2E%2E%2F (uppercase) URL-encoded traversal with 403', async () => {
    const url = new URL('http://localhost/temp-images/%2E%2E%2F.env');
    const res = await handleTempImage(url);
    expect(res.status).toBe(403);
  });

  it('blocks deeply nested traversal with 403', async () => {
    const url = new URL('http://localhost/temp-images/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd');
    const res = await handleTempImage(url);
    expect(res.status).toBe(403);
  });

  it('returns 200 for a valid image file', async () => {
    const url = new URL('http://localhost/temp-images/test-fixture.jpg');
    const res = await handleTempImage(url);
    expect(res.status).toBe(200);
  });

  it('returns 404 for a non-existent valid filename', async () => {
    const url = new URL('http://localhost/temp-images/nonexistent-image.jpg');
    const res = await handleTempImage(url);
    expect(res.status).toBe(404);
  });

  it('returns 404 when filename is missing', async () => {
    const url = new URL('http://localhost/temp-images/');
    const res = await handleTempImage(url);
    expect(res.status).toBe(404);
  });
});

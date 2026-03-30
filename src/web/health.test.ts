// Tests for /health endpoint
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { database } from '../database';

// Use a random port to avoid conflicts with running server
const TEST_PORT = 19_876 + Math.floor(Math.random() * 1000);
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  // Minimal server that replicates the /health route logic
  server = Bun.serve({
    port: TEST_PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') {
        try {
          database.groups.findById(1);
          return Response.json({ status: 'ok', uptime: process.uptime() });
        } catch {
          return Response.json({ status: 'error' }, { status: 503 });
        }
      }
      return new Response('Not Found', { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

describe('/health endpoint', () => {
  test('returns 200 with ok status', async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/health`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string; uptime: number };
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
  });

  test('returns JSON content-type', async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/health`);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

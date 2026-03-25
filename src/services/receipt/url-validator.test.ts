// Tests for SSRF protection: isUrlSafe() must block private/internal IP ranges

import { describe, expect, it } from 'bun:test';
import { isUrlSafe } from './url-validator';

describe('isUrlSafe', () => {
  describe('allowed URLs', () => {
    it('allows a normal HTTPS URL', async () => {
      // example.com resolves to a public IP — safe
      const result = await isUrlSafe('https://example.com/receipt');
      expect(result).toBe(true);
    });

    it('allows an HTTP URL with a public IP', async () => {
      // 93.184.216.34 is example.com — public
      const result = await isUrlSafe('http://93.184.216.34/path');
      expect(result).toBe(true);
    });

    it('allows HTTPS with a public IP directly', async () => {
      const result = await isUrlSafe('https://8.8.8.8/dns');
      expect(result).toBe(true);
    });
  });

  describe('blocked: private IPv4 ranges', () => {
    it('blocks 192.168.x.x', async () => {
      const result = await isUrlSafe('http://192.168.1.1/admin');
      expect(result).toBe(false);
    });

    it('blocks 192.168.0.1', async () => {
      const result = await isUrlSafe('https://192.168.0.1/');
      expect(result).toBe(false);
    });

    it('blocks 10.0.0.1', async () => {
      const result = await isUrlSafe('http://10.0.0.1/');
      expect(result).toBe(false);
    });

    it('blocks 10.255.255.255', async () => {
      const result = await isUrlSafe('http://10.255.255.255/');
      expect(result).toBe(false);
    });

    it('blocks 172.16.0.1', async () => {
      const result = await isUrlSafe('http://172.16.0.1/');
      expect(result).toBe(false);
    });

    it('blocks 172.31.255.255', async () => {
      const result = await isUrlSafe('http://172.31.255.255/');
      expect(result).toBe(false);
    });
  });

  describe('blocked: localhost', () => {
    it('blocks 127.0.0.1', async () => {
      const result = await isUrlSafe('http://127.0.0.1/');
      expect(result).toBe(false);
    });

    it('blocks 127.0.0.0', async () => {
      const result = await isUrlSafe('http://127.0.0.0/');
      expect(result).toBe(false);
    });

    it('blocks 127.255.255.255', async () => {
      const result = await isUrlSafe('http://127.255.255.255/');
      expect(result).toBe(false);
    });

    it('blocks localhost hostname', async () => {
      const result = await isUrlSafe('http://localhost/');
      expect(result).toBe(false);
    });
  });

  describe('blocked: cloud metadata', () => {
    it('blocks 169.254.169.254 (AWS metadata)', async () => {
      const result = await isUrlSafe('http://169.254.169.254/latest/meta-data/');
      expect(result).toBe(false);
    });

    it('blocks any 169.254.x.x (link-local)', async () => {
      const result = await isUrlSafe('http://169.254.0.1/');
      expect(result).toBe(false);
    });
  });

  describe('blocked: dangerous protocols', () => {
    it('blocks file:// protocol', async () => {
      const result = await isUrlSafe('file:///etc/passwd');
      expect(result).toBe(false);
    });

    it('blocks ftp:// protocol', async () => {
      const result = await isUrlSafe('ftp://example.com/file');
      expect(result).toBe(false);
    });

    it('blocks javascript: protocol', async () => {
      const result = await isUrlSafe('javascript:alert(1)');
      expect(result).toBe(false);
    });
  });

  describe('blocked: IPv6 loopback and private', () => {
    it('blocks ::1 (IPv6 loopback)', async () => {
      const result = await isUrlSafe('http://[::1]/');
      expect(result).toBe(false);
    });

    it('blocks fc00::/7 range (fc00::)', async () => {
      const result = await isUrlSafe('http://[fc00::1]/');
      expect(result).toBe(false);
    });

    it('blocks fd00::/7 range (fd00::)', async () => {
      const result = await isUrlSafe('http://[fd00::1]/');
      expect(result).toBe(false);
    });
  });

  describe('blocked: invalid or malformed URLs', () => {
    it('blocks an empty string', async () => {
      const result = await isUrlSafe('');
      expect(result).toBe(false);
    });

    it('blocks a non-URL string', async () => {
      const result = await isUrlSafe('not a url at all');
      expect(result).toBe(false);
    });
  });
});

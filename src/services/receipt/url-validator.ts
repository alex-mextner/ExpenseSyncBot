// SSRF protection: validates that a URL is safe to fetch (no private/internal IPs)

import dns from 'node:dns';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Returns true if the first octet indicates a 127.x.x.x address (loopback).
 */
function isLoopbackV4(parts: number[]): boolean {
  return parts[0] === 127;
}

/**
 * Returns true if the IPv4 address falls in a private or reserved range:
 * - 10.0.0.0/8
 * - 172.16.0.0/12  (172.16.x.x – 172.31.x.x)
 * - 192.168.0.0/16
 * - 127.0.0.0/8    (loopback)
 * - 169.254.0.0/16 (link-local / cloud metadata)
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) {
    return false;
  }
  const a = parts[0];
  const b = parts[1];
  if (a === undefined || b === undefined) return false;
  if (isLoopbackV4(parts)) return true; // 127.x.x.x
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16–31.x.x
  if (a === 192 && b === 168) return true; // 192.168.x.x
  if (a === 169 && b === 254) return true; // 169.254.x.x (link-local)
  return false;
}

/**
 * Returns true if the IPv6 address is loopback (::1) or falls in fc00::/7
 * (Unique Local Addresses: fc00:: and fd00::).
 */
function isPrivateIPv6(ip: string): boolean {
  // Strip brackets if present (URLs contain [::1])
  const bare = ip.replace(/^\[|\]$/g, '').toLowerCase();

  if (bare === '::1') return true;

  // fc00::/7 covers fc00:: through fdff:: (first 7 bits of the 128-bit address)
  // The first two hex digits of the first group must be fc or fd.
  const firstGroup = bare.split(':')[0] ?? '';
  if (firstGroup.startsWith('fc') || firstGroup.startsWith('fd')) return true;

  return false;
}

/**
 * Check whether a hostname is an IP literal and block it directly without DNS.
 * Returns true when the address is private, false when it's a public IP literal,
 * and null when the hostname is not an IP literal (needs DNS lookup).
 */
function checkIPLiteral(hostname: string): boolean | null {
  // IPv6 literal in a URL comes wrapped in brackets: [::1]
  if (hostname.startsWith('[')) {
    const ipv6 = hostname.slice(1, -1);
    return isPrivateIPv6(ipv6);
  }

  // Check if it looks like an IPv4 literal (four dot-separated octets)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return isPrivateIPv4(hostname);
  }

  return null; // not an IP literal
}

/**
 * Resolves hostname via DNS and returns true if ANY resolved address is private.
 * Checks both A (IPv4) and AAAA (IPv6) records.
 */
async function hasPrivateResolvedAddress(hostname: string): Promise<boolean> {
  const results = await Promise.allSettled([
    dns.promises.resolve4(hostname),
    dns.promises.resolve6(hostname),
  ]);

  for (const result of results) {
    if (result.status === 'rejected') continue;
    for (const addr of result.value) {
      if (isPrivateIPv4(addr) || isPrivateIPv6(addr)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Returns true if the URL is safe to fetch (public, allowed protocol, non-private IP).
 * Blocks private IPv4/IPv6 ranges, loopback, link-local, and non-HTTP(S) schemes.
 */
export async function isUrlSafe(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return false;
  }

  const hostname = parsed.hostname;

  // Fast-path: if the hostname is an IP literal, no DNS needed
  const ipCheck = checkIPLiteral(hostname);
  if (ipCheck !== null) {
    // ipCheck === true means it IS private → not safe
    return !ipCheck;
  }

  // For named hostnames, resolve and check all returned addresses
  try {
    const resolvesToPrivate = await hasPrivateResolvedAddress(hostname);
    return !resolvesToPrivate;
  } catch {
    // DNS resolution failed entirely — treat as unsafe (fail-closed)
    return false;
  }
}

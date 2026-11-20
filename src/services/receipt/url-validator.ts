// SSRF protection: validates that a URL is safe to fetch (no private/internal IPs)

import dns from 'node:dns';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Parse a dotted IPv4 address into its four octets, or null when it is not one. */
function parseIPv4(ip: string): number[] | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
  const parts = ip.split('.').map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

/**
 * IPv4 ranges that are not public unicast, as [network, prefix length]:
 * - 0.0.0.0/8      ("this network"; Linux connects 0.0.0.0 to localhost)
 * - 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 (private)
 * - 100.64.0.0/10  (carrier-grade NAT, Tailscale)
 * - 127.0.0.0/8    (loopback)
 * - 169.254.0.0/16 (link-local / cloud metadata)
 * - 192.0.0.0/24   (IETF protocol assignments)
 * - 198.18.0.0/15  (benchmarking)
 * - 224.0.0.0/3    (multicast, reserved, broadcast)
 */
const NON_PUBLIC_IPV4_RANGES: ReadonlyArray<readonly [number[], number]> = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[224, 0, 0, 0], 3],
];

function ipv4ToNumber([a = 0, b = 0, c = 0, d = 0]: number[]): number {
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/** Returns true if the IPv4 address falls in one of NON_PUBLIC_IPV4_RANGES. */
function isPrivateIPv4Parts(parts: number[]): boolean {
  const address = ipv4ToNumber(parts);
  return NON_PUBLIC_IPV4_RANGES.some(
    ([network, prefixLength]) =>
      address >>> (32 - prefixLength) === ipv4ToNumber(network) >>> (32 - prefixLength),
  );
}

/**
 * Expand an IPv6 address (with optional `::` and dotted IPv4 tail) into eight 16-bit groups,
 * or null when it is not one.
 */
function parseIPv6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)?.[1];
  if (tail) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    text = `${text.slice(0, -tail.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string | undefined): string[] => (part ? part.split(':') : []);
  const head = toGroups(halves[0]);
  const rest = toGroups(halves[1]);
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 1 ? 0 : missing).fill('0'), ...rest];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => Number.parseInt(g, 16));
}

/** The IPv4 address carried in the last 32 bits of an IPv6 address. */
function embeddedIPv4(groups: number[]): number[] {
  const [g6 = 0, g7 = 0] = groups.slice(6);
  return [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
}

/**
 * Returns true if the IPv6 address is not a public unicast address: unspecified (::),
 * loopback (::1), unique local (fc00::/7), link-local (fe80::/10), multicast (ff00::/8),
 * or an IPv4 address in IPv6 form (IPv4-mapped ::ffff:0:0/96, IPv4-compatible ::/96,
 * NAT64 64:ff9b::/96) whose IPv4 address is private. The URL parser writes
 * `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]`, so the groups are compared, not the text.
 */
function isPrivateIPv6Groups(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    // ::/96 (incl. :: and ::1) and ::ffff:0:0/96
    if (g5 === 0 || g5 === 0xffff) return isPrivateIPv4Parts(embeddedIPv4(groups));
    return true;
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIPv4Parts(embeddedIPv4(groups));
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8
  return false;
}

/**
 * Returns true if the address (IPv4 or IPv6, URL brackets allowed) must not be fetched;
 * a string that is neither counts as private (fail closed).
 */
function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '');
  const v4 = parseIPv4(bare);
  if (v4) return isPrivateIPv4Parts(v4);
  const v6 = parseIPv6(bare);
  if (v6) return isPrivateIPv6Groups(v6);
  return true;
}

/**
 * Check whether a hostname is an IP literal and block it directly without DNS.
 * Returns true when the address is private, false when it's a public IP literal,
 * and null when the hostname is not an IP literal (needs DNS lookup).
 * The URL parser has already normalized `0`, `0x7f.1` or `2130706433` to dotted form.
 */
function checkIPLiteral(hostname: string): boolean | null {
  // IPv6 literal in a URL comes wrapped in brackets: [::1]
  if (hostname.startsWith('[') || parseIPv4(hostname) !== null) {
    return isPrivateAddress(hostname);
  }
  return null; // not an IP literal
}

/** DNS resolution timeout — fail-closed if DNS hangs */
const DNS_TIMEOUT_MS = 3000;

/** Wrap a promise with a timeout that rejects on expiry */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DNS timeout')), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Resolves hostname via DNS and checks resolved addresses.
 * Returns true if ANY resolved address is private.
 * Returns null if DNS resolution failed entirely (no addresses resolved).
 * Times out after DNS_TIMEOUT_MS.
 */
async function resolveAndCheckAddresses(hostname: string): Promise<boolean | null> {
  const results = await Promise.allSettled([
    withTimeout(dns.promises.resolve4(hostname), DNS_TIMEOUT_MS),
    withTimeout(dns.promises.resolve6(hostname), DNS_TIMEOUT_MS),
  ]);

  // If ALL DNS queries failed, we have no addresses — caller must decide
  const allFailed = results.every((r) => r.status === 'rejected');
  if (allFailed) return null;

  for (const result of results) {
    if (result.status === 'rejected') continue;
    for (const addr of result.value) {
      if (isPrivateAddress(addr)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Returns true if the URL is safe to fetch (public, allowed protocol, non-private IP).
 * Blocks private, reserved, loopback, link-local and IPv4-in-IPv6 forms of them, and
 * non-HTTP(S) schemes. `fetch` resolves the name again on its own, so a DNS answer that
 * changes between the check and the connect (rebinding) is not covered here.
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
  const result = await resolveAndCheckAddresses(hostname);
  // null = DNS failed entirely — fail-closed (treat as unsafe)
  if (result === null) return false;
  // true = private IP found — not safe
  return !result;
}

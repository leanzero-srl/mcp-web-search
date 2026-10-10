/**
 * Utility functions for the web search MCP server
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import http from 'http';
import https from 'https';
import dns from 'dns/promises';
import dnsCb from 'dns';
import net from 'net';

/**
 * Substring stamped into every SSRF refusal so callers can tell a deliberate
 * block apart from a transient network failure (e.g. the PDF extractor must NOT
 * fall back to a headless browser — which follows redirects we cannot police —
 * when the HTTP path was refused for pointing at an internal address).
 */
export const SSRF_BLOCK_MARKER = 'ssrf-blocked';

/**
 * IP ranges a URL-fetching server must never be steered into by an LLM-supplied
 * URL: loopback, RFC1918 private, CGNAT (100.64/10 — this is the Tailscale
 * tailnet range, and the workhorse's own services answer on 100.122.51.13),
 * link-local + cloud metadata (169.254/16), multicast/reserved, NAT64, ULA, and
 * — because Node's BlockList evaluates an IPv4-mapped IPv6 address against the
 * IPv4 rules itself — the ::ffff: forms of all of the above. Using a BlockList
 * (not string prefixes) is what closes the `[::ffff:127.0.0.1]` bypass the old
 * hand-rolled check let through.
 */
const BLOCKED = new net.BlockList();
for (const [subnet, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as Array<[string, number]>) BLOCKED.addSubnet(subnet, prefix, 'ipv4');
for (const [subnet, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64],
  ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as Array<[string, number]>) BLOCKED.addSubnet(subnet, prefix, 'ipv6');

/**
 * True when an IP literal (v4 or v6) is in a range this server must not reach.
 * Anything that is not a parseable IP returns true (fail closed).
 */
export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return BLOCKED.check(ip, 'ipv4');
  if (family === 6) return BLOCKED.check(ip, 'ipv6');
  return true;
}

/**
 * A `dns.lookup`-shaped function for http/https Agents that refuses to hand the
 * socket layer a blocked address. Because it runs at CONNECT time it also
 * covers redirect hops to hostnames and DNS-rebinding (the resolved address is
 * re-checked for every connection), which a one-shot pre-flight check cannot.
 * NOTE: Node skips `lookup` entirely when the host is already an IP literal, so
 * literal-IP targets are caught by `safeFetchUrl` (initial URL) and
 * `beforeRedirectGuard` (redirect hops), not here.
 */
function guardedLookup(
  hostname: string,
  options: dnsCb.LookupOneOptions | dnsCb.LookupAllOptions | dnsCb.LookupOptions | ((err: NodeJS.ErrnoException | null, address: string, family: number) => void),
  callback?: (err: NodeJS.ErrnoException | null, address: string | dnsCb.LookupAddress[], family: number) => void,
): void {
  const cb = (typeof options === 'function' ? options : callback) as (err: NodeJS.ErrnoException | null, address: unknown, family: number) => void;
  const opts = (typeof options === 'function' ? {} : options) as dnsCb.LookupOptions;
  dnsCb.lookup(hostname, opts, (err, address, family) => {
    if (err) return cb(err, address as unknown, family);
    const addrs = Array.isArray(address) ? address.map((a) => a.address) : [address];
    for (const a of addrs) {
      if (isBlockedAddress(a)) {
        const e = new Error(`${SSRF_BLOCK_MARKER}: refused connection to private/reserved address ${a} (for host ${hostname})`) as NodeJS.ErrnoException;
        e.code = 'ESSRFBLOCKED';
        return cb(e, '', 0);
      }
    }
    cb(null, address as unknown, family);
  });
}

// Shared HTTP/HTTPS agents with keep-alive connection pooling AND the SSRF
// lookup guard, so every axios call that spreads getAxiosHttpAgentConfig() is
// protected on the initial connection and on every redirect hop.
const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, lookup: guardedLookup });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, lookup: guardedLookup });

/**
 * Follow-redirects `beforeRedirect` hook: refuse a redirect hop whose target is
 * a literal blocked IP. The agent `lookup` already covers hostname hops; this
 * closes the gap Node leaves for IP-literal hosts (e.g. a 302 to
 * `http://127.0.0.1:10000/…`), which skip `lookup` entirely.
 */
export function beforeRedirectGuard(options: { hostname?: string; host?: string }): void {
  const raw = options.hostname || options.host || '';
  const host = raw.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedAddress(host)) {
    throw new Error(`${SSRF_BLOCK_MARKER}: refused redirect to private/reserved address ${host}`);
  }
}

/**
 * Shared axios config for any request to a CALLER-SUPPLIED URL: connection
 * pooling + the SSRF-guarded agents + the redirect guard. Spreading this into
 * an axios call is the single thing that makes that call safe against loopback /
 * private-range SSRF, including via redirects and DNS rebinding.
 */
export function getAxiosHttpAgentConfig(): {
  httpAgent: http.Agent;
  httpsAgent: https.Agent;
  beforeRedirect: typeof beforeRedirectGuard;
} {
  return { httpAgent, httpsAgent, beforeRedirect: beforeRedirectGuard };
}

export function cleanText(text: string, maxLength: number = 10000): string {
  return text
    .replace(/\s+/g, ' ') // Replace multiple whitespace with single space
    .replace(/\n\s*\n/g, '\n') // Replace multiple newlines with single newline
    .trim()
    .substring(0, maxLength);
}

export function getWordCount(text: string): number {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

export interface ReadWindow {
  body: string;
  start: number;
  end: number;
  totalLen: number;
  hasMore: boolean;
}

/**
 * Computes a bounded read window over a string for paginated readback. `offset`
 * and `maxChars` are clamped so the result is always a valid sub-range no matter
 * the inputs; `hasMore` reports whether content remains past `end` — the caller
 * uses `end` as the next page's offset. Measured in JS string characters.
 */
export function clampReadWindow(raw: string, offset: number, maxChars: number): ReadWindow {
  const totalLen = raw.length;
  const safeOffset = Math.max(0, Math.floor(offset) || 0);
  const safeMax = Math.max(1, Math.floor(maxChars) || 1);
  const start = Math.min(safeOffset, totalLen);
  const end = Math.min(start + safeMax, totalLen);
  return { body: raw.substring(start, end), start, end, totalLen, hasMore: end < totalLen };
}

export function getContentPreview(text: string, maxLength: number = 500): string {
  const cleaned = cleanText(text, maxLength);
  return cleaned.length === maxLength ? cleaned + '...' : cleaned;
}

export function generateTimestamp(): string {
  return new Date().toISOString();
}

export function validateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validates a URL is safe to fetch: rejects non-http(s) schemes, malformed
 * URLs, and (after DNS resolution) addresses pointing at loopback / link-local /
 * RFC1918 / CGNAT / cloud-metadata / multicast targets. Throws on rejection so
 * callers surface a structured error instead of silently fetching an internal
 * target. Every refusal message contains SSRF_BLOCK_MARKER.
 *
 * This is the PRE-FLIGHT gate on the initial URL. The redirect/rebinding gaps a
 * one-shot check leaves open are closed separately by the SSRF-guarded agents
 * (hostname hops) and beforeRedirectGuard (IP-literal hops) wired through
 * getAxiosHttpAgentConfig(); the browser path never fetches a URL this gate
 * rejected, and refuses to fall back to the browser for a blocked HTTP error.
 */
export async function safeFetchUrl(url: string): Promise<void> {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error(`Invalid URL: must be a non-empty string (${SSRF_BLOCK_MARKER})`);
  }
  if (!validateUrl(url)) {
    throw new Error(`Invalid URL: only http and https schemes are allowed (got: ${url.slice(0, 80)}) (${SSRF_BLOCK_MARKER})`);
  }

  const parsed = new URL(url);
  // URL.hostname wraps IPv6 literals in brackets ("[::1]") — strip them so
  // net.isIP / the BlockList see the bare address. (This also normalises forms
  // like [::ffff:127.0.0.1] → ::ffff:7f00:1, which the BlockList catches.)
  const host = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname;

  // Reject literal IP hostnames in private ranges directly (no DNS needed)
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new Error(`Refused to fetch private/reserved address: ${host} (${SSRF_BLOCK_MARKER})`);
    }
    return;
  }

  // Hostname-level shortcut for "localhost"
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error(`Refused to fetch local hostname: ${host} (${SSRF_BLOCK_MARKER})`);
  }

  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    for (const rec of records) {
      if (isBlockedAddress(rec.address)) {
        throw new Error(`Refused to fetch ${host}: resolves to private/reserved address ${rec.address} (${SSRF_BLOCK_MARKER})`);
      }
    }
  } catch (err) {
    // Re-throw our own refusals; DNS errors (NXDOMAIN, etc.) bubble up as the
    // caller will see them anyway during the actual fetch.
    if (err instanceof Error && err.message.includes(SSRF_BLOCK_MARKER)) {
      throw err;
    }
    // DNS lookup failure: let the actual request fail naturally with a clearer
    // network error rather than masking it as an SSRF rejection.
  }
}

export function sanitizeQuery(query: string): string {
  return query.trim().substring(0, 1000); // Limit query length
}

export function getRandomUserAgent(): string {
  const userAgents = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wraps a promise with a hard wall-clock timeout. On timeout we throw an
 * Error whose message contains "timeout" so the existing `handleError` mapper
 * in the MCP layer translates it to MCP error code `-32001` (RequestTimeout)
 * instead of a generic InternalError. The wrapped work is *not* cancelled
 * (we don't have AbortSignal threading through every Playwright call yet);
 * the timeout simply means the caller stops waiting. Internal cleanup still
 * happens via finally blocks.
 *
 * Use this at tool-handler boundaries to enforce predictable upper bounds
 * suitable for the Forge → LM Studio → MCP latency chain (~25 s function
 * timeout in Forge, leaving room for inference and network).
 */
export function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timeout after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Generates a unique identifier for caching and tracking purposes
 */
export function generateUUID(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

export function isPdfUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Check if pathname ends with .pdf OR if query string contains a .pdf parameter
    const pathIsPdf = parsed.pathname.toLowerCase().endsWith('.pdf');
    
    // Also check search params for .pdf extensions (e.g., file.pdf?download=1)
    const searchParamsHavePdf = [...parsed.searchParams.entries()].some(
      (entry) => entry[1].toLowerCase().includes('.pdf')
    );
    
    return pathIsPdf || searchParamsHavePdf;
  } catch {
    // If URL parsing fails, check the raw string as fallback
    return url.toLowerCase().endsWith('.pdf');
  }
}

/**
 * Fetches and parses a sitemap from a given base URL.
 * Implements robust discovery via robots.txt, root sitemaps, and recursive index parsing.
 */
export async function fetchSitemapUrls(baseUrl: string): Promise<string[]> {
  await safeFetchUrl(baseUrl);

  const urlObj = new URL(baseUrl);
  const origin = urlObj.origin;
  const allUrls = new Set<string>();
  const visitedSitemaps = new Set<string>();

  console.log(`[Utils] Starting robust sitemap discovery for: ${baseUrl}`);

  // 1. Try to discover sitemaps via robots.txt (The gold standard)
  try {
    const robotsUrl = `${origin}/robots.txt`;
    console.log(`[Utils] Checking robots.txt at: ${robotsUrl}`);
    const robotsResponse = await axios.get(robotsUrl, {
      timeout: 5000,
      headers: { 'User-Agent': getRandomUserAgent() },
      ...getAxiosHttpAgentConfig(),
    });
    const robotsText = robotsResponse.data as string;
    const sitemapMatches = robotsText.matchAll(/^Sitemap:\s*(https?:\/\/[^\s]+)/gmi);
    for (const match of sitemapMatches) {
      allUrls.add(match[1]);
    }
  } catch {
    console.log(`[Utils] No sitemaps found in robots.txt or file missing`);
  }

  // 2. Try common default locations if robots.txt didn't provide enough
  const commonLocations = [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap1.xml`
  ];

  for (const loc of commonLocations) {
    allUrls.add(loc);
  }

  // 3. Recursively process all discovered sitemaps to handle Sitemap Indexes
  const queue = Array.from(allUrls);
  let processedCount = 0;

  while (queue.length > 0 && processedCount < 10) { // Limit depth/count to prevent infinite loops
    const currentSitemapUrl = queue.shift()!;
    if (visitedSitemaps.has(currentSitemapUrl)) continue;
    visitedSitemaps.add(currentSitemapUrl);
    processedCount++;

    try {
      // Validate each sitemap URL — robots.txt and sitemap-index files can
      // declare cross-host or pathological URLs.
      await safeFetchUrl(currentSitemapUrl);
      console.log(`[Utils] Fetching sitemap: ${currentSitemapUrl}`);
      const response = await axios.get(currentSitemapUrl, {
        timeout: 10000,
        headers: { 'User-Agent': getRandomUserAgent() },
        ...getAxiosHttpAgentConfig(),
      });

      const $ = cheerio.load(response.data, { xmlMode: true });
      const locs: string[] = [];
      
      $('loc').each((_, el) => {
        const loc = $(el).text().trim();
        if (loc) locs.push(loc);
      });

      for (const loc of locs) {
        // If the location looks like another sitemap, add it to the queue for processing
        if (loc.toLowerCase().includes('sitemap')) {
          queue.push(loc);
        } else {
          allUrls.add(loc);
        }
      }
    } catch (error) {
      console.log(`[Utils] Failed to fetch sitemap ${currentSitemapUrl}: ${error instanceof Error ? error.message : 'Error'}`);
    }
  }

  const finalUrls = Array.from(allUrls).filter(url => !url.toLowerCase().includes('sitemap'));
  console.log(`[Utils] Sitemap discovery completed. Found ${finalUrls.length} page URLs.`);
  return finalUrls;
}

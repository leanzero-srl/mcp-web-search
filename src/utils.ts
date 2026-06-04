/**
 * Utility functions for the web search MCP server
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import http from 'http';
import https from 'https';
import dns from 'dns/promises';
import net from 'net';

// Shared HTTP/HTTPS agents with keep-alive connection pooling
const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000 });

/**
 * Get shared axios config with connection pooling (keep-alive)
 * Use this for all HTTP clients to reduce TCP handshake overhead
 */
export function getAxiosHttpAgentConfig(): { httpAgent: http.Agent; httpsAgent: https.Agent } {
  return { httpAgent, httpsAgent };
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
 * Returns true when an IP address (v4 or v6) lives in a range that should never
 * be reachable from a server fetching arbitrary URLs supplied by an LLM:
 * loopback, link-local, RFC1918 private, multicast, broadcast, cloud metadata
 * (169.254.169.254), unique local addresses (fc00::/7), and the IPv6 mappings
 * of all of the above.
 */
function isPrivateOrReservedIp(ip: string): boolean {
  if (!ip) return true;

  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map((n) => parseInt(n, 10));
    if (Number.isNaN(a) || Number.isNaN(b)) return true;
    if (a === 0) return true;                       // 0.0.0.0/8
    if (a === 10) return true;                      // 10.0.0.0/8 RFC1918
    if (a === 127) return true;                     // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true;        // 169.254.0.0/16 link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
    if (a === 192 && b === 168) return true;        // 192.168.0.0/16 RFC1918
    if (a === 192 && b === 0) return true;          // 192.0.0.0/24 IETF protocol
    if (a >= 224) return true;                      // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
    return false;
  }

  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe80:') || lower.startsWith('fe8') || lower.startsWith('fec') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local fe80::/10
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local fc00::/7
    if (lower.startsWith('ff')) return true;        // multicast ff00::/8
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — recurse on the v4 portion
    if (lower.startsWith('::ffff:')) {
      const v4 = lower.split('::ffff:')[1];
      if (v4 && net.isIPv4(v4)) return isPrivateOrReservedIp(v4);
    }
    return false;
  }

  return true; // not a parseable IP
}

/**
 * Validates a URL is safe to fetch. Rejects non-http(s) schemes, malformed
 * URLs, and (after DNS resolution) addresses pointing at loopback / link-local /
 * RFC1918 / cloud-metadata / multicast targets. Throws on rejection so callers
 * surface a structured error instead of silently fetching an internal target.
 *
 * Note: DNS resolution is best-effort for SSRF defense — a TOCTOU window
 * between resolution and the actual axios/playwright fetch still exists. For
 * stronger guarantees, route requests through a custom http.Agent that blocks
 * the same ranges in `lookup`. This guard catches the common cases.
 */
export async function safeFetchUrl(url: string): Promise<void> {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('Invalid URL: must be a non-empty string');
  }
  if (!validateUrl(url)) {
    throw new Error(`Invalid URL: only http and https schemes are allowed (got: ${url.slice(0, 80)})`);
  }

  const parsed = new URL(url);
  // URL.hostname wraps IPv6 literals in brackets ("[::1]") — strip them so
  // net.isIP / our range check see the bare address.
  const host = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname;

  // Reject literal IP hostnames in private ranges directly (no DNS needed)
  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new Error(`Refused to fetch private/reserved address: ${host}`);
    }
    return;
  }

  // Hostname-level shortcut for "localhost"
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error(`Refused to fetch local hostname: ${host}`);
  }

  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    for (const rec of records) {
      if (isPrivateOrReservedIp(rec.address)) {
        throw new Error(`Refused to fetch ${host}: resolves to private/reserved address ${rec.address}`);
      }
    }
  } catch (err) {
    // Re-throw our own refusals; DNS errors (NXDOMAIN, etc.) bubble up as the
    // caller will see them anyway during the actual fetch.
    if (err instanceof Error && err.message.startsWith('Refused to fetch')) {
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
      headers: { 'User-Agent': getRandomUserAgent() } 
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

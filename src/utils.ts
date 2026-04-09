/**
 * Utility functions for the web search MCP server
 */

import axios from 'axios';
import * as cheerio from 'cheerio';

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
  } catch (e) {
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
      console.log(`[Utils] Fetching sitemap: ${currentSitemapUrl}`);
      const response = await axios.get(currentSitemapUrl, { 
        timeout: 10000, 
        headers: { 'User-Agent': getRandomUserAgent() } 
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

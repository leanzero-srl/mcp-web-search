/**
 * Core tools over stdio, against the live web. See ./utils.ts for the rules
 * (search tests skip with the reason in their name when SERPER_API_KEY is absent).
 */
import './setup.ts';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStdioServer, callOk, callTool, searchIt, resultUrls, summaryItems, type Started } from './utils.js';

const EXPECTED_TOOLS = [
  'full-web-search', 'get-web-search-summaries', 'get-single-web-page-content', 'research_and_save_to_markdown',
  'get-website-sitemap', 'get-github-repo-content', 'get-openapi-spec', 'progressive-web-search', 'get-pdf-content',
  'list-cached-documents', 'read-cached-document',
];

describe('MCP tools over stdio (live)', () => {
  let s: Started;
  beforeAll(async () => { s = await startStdioServer('mcp-tools'); }, 120000);
  afterAll(async () => { await s?.close(); });

  it('lists exactly the 11 shipped tools (cached-web-search was folded into full-web-search in e5d26a6)', async () => {
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  searchIt('full-web-search returns real results with extracted content', async () => {
    const text = await callOk(s.client, 'full-web-search', { query: 'TypeScript handbook generics', limit: 2, includeContent: true });
    const urls = resultUrls(text);
    expect(urls.length).toBeGreaterThanOrEqual(1);
    expect(urls.length).toBeLessThanOrEqual(2);
    expect(text).toMatch(/Search completed for ".*" with [1-9]\d* results/);
    expect(text.toLowerCase()).toContain('typescript');
  }, 120000);

  searchIt('get-web-search-summaries returns titled results with http URLs and no page content', async () => {
    const text = await callOk(s.client, 'get-web-search-summaries', { query: 'Node.js release schedule', limit: 3 });
    const items = summaryItems(text);
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.length).toBeLessThanOrEqual(3);
    for (const item of items) {
      expect(item.url).toMatch(/^https?:\/\//);
      expect(item.title.length).toBeGreaterThan(0);
    }
    expect(text).not.toContain('Full Content');
  }, 120000);

  searchIt('progressive-web-search returns ranked results within the limit', async () => {
    const text = await callOk(s.client, 'progressive-web-search', { query: 'vitest snapshot testing', maxDepth: 2, limit: 3 });
    const urls = resultUrls(text);
    expect(urls.length).toBeGreaterThanOrEqual(1);
    expect(urls.length).toBeLessThanOrEqual(3);
    expect(text).toMatch(/Relevance Score: \d/);
  }, 150000);

  it('get-single-web-page-content extracts the article text of a real page', async () => {
    const text = await callOk(s.client, 'get-single-web-page-content', { url: 'https://en.wikipedia.org/wiki/TypeScript' });
    expect(text).toContain('**Source:** https://en.wikipedia.org/wiki/TypeScript');
    expect(text).toContain('Microsoft');
    expect(text).toMatch(/superset of JavaScript|static typing/i);
    const words = Number(text.match(/\*\*Words:\*\* (\d+)/)?.[1]);
    expect(words).toBeGreaterThan(1000);
  });

  it('get-single-web-page-content returns visible text only — no CSS/JS (example.com injects a <style> into <body>)', async () => {
    const text = await callOk(s.client, 'get-single-web-page-content', { url: 'https://example.com' });
    expect(text).toContain('This domain is for use in documentation examples');
    expect(text).not.toMatch(/\{\s*display\s*:|margin:\s*-?\d|function\s*\(/);
  });

  it('a malformed call is rejected with a tool error naming the problem', async () => {
    const r = await callTool(s.client, 'full-web-search', { query: '', limit: -1 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/query is required|Invalid limit/);
  });
});

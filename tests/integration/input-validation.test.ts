/**
 * Input validation over stdio. Every case asserts the SPECIFIC refusal; the old
 * version wrapped `expect(true).toBe(false)` in try/catch, which caught its own
 * assertion error, so every case passed whatever the server did.
 * Hermetic except the one search case (skips without SERPER_API_KEY).
 */
import './setup.ts';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStdioServer, callTool, callOk, searchIt, summaryItems, type Started } from './utils.js';

describe('Input validation (stdio)', () => {
  let s: Started;
  beforeAll(async () => { s = await startStdioServer('input-validation'); }, 120000);
  afterAll(async () => { await s?.close(); });

  const rejects = (name: string, tool: string, args: Record<string, unknown>, message: RegExp) =>
    it(name, async () => {
      const r = await callTool(s.client, tool, args, 15000);
      expect(r.isError, `expected a tool error, got: ${r.text.slice(0, 200)}`).toBe(true);
      expect(r.text).toMatch(message);
    });

  rejects('empty query', 'full-web-search', { query: '', limit: 5 }, /query is required/);
  rejects('missing query', 'full-web-search', { limit: 5 }, /query|Required/i);
  rejects('negative limit', 'full-web-search', { query: 'x', limit: -1 }, /Invalid limit: must be a number between 1 and 10/);
  rejects('zero limit', 'full-web-search', { query: 'x', limit: 0 }, /Invalid limit: must be a number between 1 and 10/);
  rejects('limit above 10', 'full-web-search', { query: 'x', limit: 10000 }, /Invalid limit: must be a number between 1 and 10/);
  rejects('summaries limit above 10', 'get-web-search-summaries', { query: 'x', limit: 50 }, /limit/i);
  rejects('not a URL', 'get-single-web-page-content', { url: 'not-a-valid-url-format' }, /Invalid url/);
  rejects('ftp scheme', 'get-single-web-page-content', { url: 'ftp://invalid-scheme.com/file.pdf' }, /only http and https.*ssrf-blocked/);
  rejects('file scheme', 'get-single-web-page-content', { url: 'file:///etc/passwd' }, /only http and https.*ssrf-blocked/);
  rejects('loopback target', 'get-single-web-page-content', { url: 'http://127.0.0.1:1/' }, /ssrf-blocked/);
  rejects('negative maxContentLength', 'get-single-web-page-content', { url: 'https://example.com', maxContentLength: -500 },
    /greater than or equal to 0.*maxContentLength/);
  rejects('fractional maxContentLength', 'get-pdf-content', { url: 'https://example.com/a.pdf', maxContentLength: 10.5 },
    /integer.*maxContentLength|maxContentLength.*integer/i);
  rejects('unknown tool', 'non-existent-tool-12345', {}, /not found/);

  searchIt('accepts a query with quotes and parentheses and returns results', async () => {
    const text = await callOk(s.client, 'get-web-search-summaries', { query: 'TypeScript "generics" tutorial (handbook)', limit: 2 });
    expect(summaryItems(text).length).toBeGreaterThanOrEqual(1);
  }, 120000);
});

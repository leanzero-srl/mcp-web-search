/**
 * Large responses survive the stdio transport intact. The old version wrapped
 * most cases in try/catch and asserted nothing.
 */
import './setup.ts';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStdioServer, callOk, callTool, searchIt, resultUrls, skipIfAnonymousGithubRateLimit, type Started } from './utils.js';

describe('Large responses (stdio, live)', () => {
  let s: Started;
  beforeAll(async () => { s = await startStdioServer('large-responses'); }, 120000);
  afterAll(async () => { await s?.close(); });

  it('a very long article comes through whole when no limit is set', async () => {
    const text = await callOk(s.client, 'get-single-web-page-content', { url: 'https://en.wikipedia.org/wiki/JavaScript' }, 120000);
    expect(text.length).toBeGreaterThan(50000);
    expect(text).toContain('Brendan Eich');
    expect(text).not.toContain('[Content truncated');
  }, 130000);

  it('a large PDF (arXiv 1706.03762, "Attention Is All You Need") extracts with its page count', async () => {
    const text = await callOk(s.client, 'get-pdf-content', { url: 'https://arxiv.org/pdf/1706.03762', maxContentLength: 5000 }, 120000);
    expect(text).toMatch(/Attention Is All\s+You Need/i);
    expect(Number(text.match(/\*\*Pages:\*\* (\d+)/)?.[1])).toBeGreaterThanOrEqual(10);
  }, 130000);

  it('a GitHub crawl of a big repository returns README and file previews', async (ctx) => {
    const r = await callTool(s.client, 'get-github-repo-content', { url: 'https://github.com/microsoft/TypeScript', maxFiles: 10 }, 120000);
    skipIfAnonymousGithubRateLimit(ctx, r);
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain('# TypeScript');
    expect(Number(r.text.match(/\*\*Files \((\d+),/)?.[1])).toBeGreaterThanOrEqual(1);
  }, 130000);

  searchIt('full-web-search with the maximum limit (10) returns at most 10 results', async () => {
    const text = await callOk(s.client, 'full-web-search', { query: 'open source web frameworks comparison', limit: 10, includeContent: true }, 180000);
    const n = resultUrls(text).length;
    expect(n).toBeGreaterThanOrEqual(3);
    expect(n).toBeLessThanOrEqual(10);
  }, 190000);
});

/**
 * progressive-web-search: literal search first, expanded stages only when the
 * first stage is thin. Every case is a live search (skips without
 * SERPER_API_KEY). Kept to three calls: each stage costs a Serper query.
 */
import './setup.ts';
import { describe, expect, beforeAll, afterAll } from 'vitest';
import { startStdioServer, callOk, searchIt, resultUrls, type Started } from './utils.js';

describe('Progressive search (stdio, live)', () => {
  let s: Started;
  beforeAll(async () => { s = await startStdioServer('progressive'); }, 120000);
  afterAll(async () => { await s?.close(); });

  searchIt('returns results with stage, query used and relevance for each', async () => {
    const text = await callOk(s.client, 'progressive-web-search', { query: 'React server components data fetching', maxDepth: 2, limit: 5 }, 150000);
    const urls = resultUrls(text);
    expect(urls.length).toBeGreaterThanOrEqual(1);
    expect(urls.length).toBeLessThanOrEqual(5);
    expect(text).toMatch(/Stage: [12]\n/);
    expect(text).toMatch(/Query Used: ".+"/);
  }, 160000);

  searchIt('maxDepth 1 never uses a stage beyond the first', async () => {
    const text = await callOk(s.client, 'progressive-web-search', { query: 'Python asyncio gather vs wait', maxDepth: 1, limit: 5 }, 150000);
    expect(resultUrls(text).length).toBeGreaterThanOrEqual(1);
    expect(text).not.toMatch(/Stage: [2-9]/);
  }, 160000);

  searchIt('respects a small limit', async () => {
    const text = await callOk(s.client, 'progressive-web-search', { query: 'Go generics constraints', maxDepth: 2, limit: 2 }, 150000);
    const n = resultUrls(text).length;
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(2);
  }, 160000);
});

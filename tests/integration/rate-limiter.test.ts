/**
 * The search path's rate limiter under normal use: back-to-back searches are all
 * served with results (the limiter waits rather than failing a short burst).
 * Its edge semantics are unit-tested in tests/unit/rate-limiter.test.ts.
 */
import './setup.ts';
import { describe, expect, beforeAll, afterAll } from 'vitest';
import { startStdioServer, callOk, searchIt, summaryItems, type Started } from './utils.js';

describe('Rate limiter under normal use (stdio, live)', () => {
  let s: Started;
  beforeAll(async () => { s = await startStdioServer('rate-limiter'); }, 120000);
  afterAll(async () => { await s?.close(); });

  searchIt('three back-to-back searches all return results', async () => {
    for (const q of ['Rust ownership explained', 'PostgreSQL vacuum tuning', 'HTTP 429 Retry-After header']) {
      const text = await callOk(s.client, 'get-web-search-summaries', { query: q, limit: 2 }, 60000);
      expect(summaryItems(text).length, `no results for "${q}"`).toBeGreaterThanOrEqual(1);
    }
  }, 200000);
});

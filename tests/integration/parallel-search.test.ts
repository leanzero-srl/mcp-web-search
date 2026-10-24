/**
 * Concurrency integrity: parallel calls each get THEIR OWN answer (the request
 * deduplicator keys must never cross results). Kept small on purpose — this
 * runs daily against real sites; the old version fired 15-way search bursts and
 * asserted only that something resolved.
 */
import './setup.ts';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStdioServer, callOk, searchIt, summaryItems, type Started } from './utils.js';

describe('Parallel calls (stdio, live)', () => {
  let s: Started;
  beforeAll(async () => { s = await startStdioServer('parallel'); }, 120000);
  afterAll(async () => { await s?.close(); });

  it('three different pages fetched in parallel each return their own content', async () => {
    const pages = [
      ['https://en.wikipedia.org/wiki/TypeScript', 'TypeScript'],
      ['https://en.wikipedia.org/wiki/Rust_(programming_language)', 'Rust'],
      ['https://example.com', 'This domain is for use in documentation examples'],
    ] as const;
    const texts = await Promise.all(pages.map(([url]) => callOk(s.client, 'get-single-web-page-content', { url, maxContentLength: 3000 })));
    texts.forEach((t, i) => {
      expect(t).toContain(`**Source:** ${pages[i][0]}`);
      expect(t).toContain(pages[i][1]);
    });
  }, 120000);

  it('the same page requested twice at once is served to both callers', async () => {
    const [a, b] = await Promise.all([1, 2].map(() =>
      callOk(s.client, 'get-single-web-page-content', { url: 'https://en.wikipedia.org/wiki/Node.js', maxContentLength: 2000 })));
    expect(a).toContain('**Source:** https://en.wikipedia.org/wiki/Node.js');
    expect(b).toContain('**Source:** https://en.wikipedia.org/wiki/Node.js');
  }, 120000);

  searchIt('three searches in parallel each return results for their own query', async () => {
    const queries = ['SQLite WAL mode', 'Redis streams consumer groups', 'nginx reverse proxy websocket'];
    const texts = await Promise.all(queries.map((query) => callOk(s.client, 'get-web-search-summaries', { query, limit: 2 }, 120000)));
    texts.forEach((t, i) => {
      expect(t).toContain(`Search summaries for "${queries[i]}"`);
      expect(summaryItems(t).length).toBeGreaterThanOrEqual(1);
    });
  }, 150000);
});

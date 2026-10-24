/**
 * Output limits are honoured. maxContentLength semantics (schema text): 0 = no
 * limit; for get-single-web-page-content the cap applies to the whole response
 * and ends with a truncation marker.
 */
import './setup.ts';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStdioServer, callOk, searchIt, resultUrls, summaryItems, type Started } from './utils.js';

const PAGE = 'https://en.wikipedia.org/wiki/JavaScript';

describe('Output limiting (stdio, live)', () => {
  let s: Started;
  beforeAll(async () => { s = await startStdioServer('output-limiting'); }, 120000);
  afterAll(async () => { await s?.close(); });

  it('maxContentLength caps the whole response and says it truncated', async () => {
    const text = await callOk(s.client, 'get-single-web-page-content', { url: PAGE, maxContentLength: 1000 });
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).toContain('[Content truncated');
    expect(text).toContain('**Source:** ' + PAGE);
  });

  it('maxContentLength 0 means no limit', async () => {
    const text = await callOk(s.client, 'get-single-web-page-content', { url: PAGE, maxContentLength: 0 });
    expect(text.length).toBeGreaterThan(20000);
    expect(text).not.toContain('[Content truncated');
  });

  it('a limit larger than the page returns the page untruncated', async () => {
    const text = await callOk(s.client, 'get-single-web-page-content', { url: 'https://example.com', maxContentLength: 100000 });
    expect(text).toContain('This domain is for use in documentation examples');
    expect(text).not.toContain('[Content truncated');
  });

  searchIt('full-web-search returns no more results than the limit', async () => {
    const text = await callOk(s.client, 'full-web-search', { query: 'kubernetes pod lifecycle', limit: 3, includeContent: false }, 120000);
    const n = resultUrls(text).length;
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(3);
  }, 130000);

  searchIt('get-web-search-summaries returns no more results than the limit', async () => {
    const items = summaryItems(await callOk(s.client, 'get-web-search-summaries', { query: 'kubernetes pod lifecycle', limit: 2 }));
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.length).toBeLessThanOrEqual(2);
  }, 130000);
});

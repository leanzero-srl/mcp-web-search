/**
 * SearchEngine (in-process): the Serper path and the documented keyless
 * behaviour. The old version ran without a key and asserted only that
 * `results` was defined, so it could not fail.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SearchEngine } from '../../src/search-engine.js';
import { requestContext } from '../../src/request-context.js';
import { searchIt } from './utils.js';

describe('SearchEngine (in-process)', () => {
  let engine: SearchEngine;
  beforeAll(() => { engine = new SearchEngine(); });
  afterAll(async () => { await engine.closeAll(); });

  searchIt('returns Serper results with titles and http URLs', async () => {
    const r = await engine.search({ query: 'Model Context Protocol specification', numResults: 3 });
    expect(r.engine).toBe('serper-only');
    expect(r.results.length).toBeGreaterThanOrEqual(1);
    for (const item of r.results) {
      expect(item.url).toMatch(/^https?:\/\//);
      expect(item.title.length).toBeGreaterThan(0);
    }
  }, 60000);

  it('without any Serper key it returns no results and names why (engine "serper-failed-no-fallback")', async () => {
    const saved = process.env.SERPER_API_KEY;
    delete process.env.SERPER_API_KEY;
    try {
      // An explicit empty per-request context: no caller key either.
      const r = await requestContext.run({} as never, () => engine.search({ query: 'keyless probe ' + Date.now(), numResults: 1 }));
      expect(r.results).toEqual([]);
      expect(r.engine).toBe('serper-failed-no-fallback');
    } finally {
      if (saved !== undefined) process.env.SERPER_API_KEY = saved;
    }
  }, 30000);
});

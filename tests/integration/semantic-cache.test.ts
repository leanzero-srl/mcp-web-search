/**
 * Semantic cache. The separate `cached-web-search` tool these tests used to call
 * was removed in e5d26a6 (13 -> 11 tools): the Upstash semantic cache now sits
 * inside the search engine, and a hit shows as "Search engine: semantic-cache"
 * in full-web-search's Status line. The cache only exists when
 * UPSTASH_VECTOR_REST_URL / UPSTASH_VECTOR_REST_TOKEN are set, so the round
 * trip skips (with the reason in its name) without them.
 */
import './setup.ts';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStdioServer, callOk, HAS_SERPER, resultUrls, type Started } from './utils.js';

const HAS_UPSTASH = !!(process.env.UPSTASH_VECTOR_REST_URL && process.env.UPSTASH_VECTOR_REST_TOKEN);

describe('Semantic cache (stdio, live)', () => {
  let s: Started;
  beforeAll(async () => { s = await startStdioServer('semantic-cache'); }, 120000);
  afterAll(async () => { await s?.close(); });

  it('the removed cached-web-search tool stays removed (one search tool, cache built in)', async () => {
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('cached-web-search');
    expect(tools.map((t) => t.name)).toContain('full-web-search');
  });

  const roundTrip = HAS_UPSTASH && HAS_SERPER ? it : it.skip;
  const note = HAS_UPSTASH && HAS_SERPER ? '' : ' [SKIPPED: needs UPSTASH_VECTOR_REST_URL/TOKEN and SERPER_API_KEY]';
  roundTrip('a repeated query is answered from the semantic cache with the same results' + note, async () => {
    const query = `semantic cache probe ${new Date().toISOString().slice(0, 10)} typescript decorators`;
    const first = await callOk(s.client, 'full-web-search', { query, limit: 2, includeContent: false });
    expect(first).not.toContain('Search engine: semantic-cache');
    const second = await callOk(s.client, 'full-web-search', { query, limit: 2, includeContent: false });
    expect(second).toContain('Search engine: semantic-cache');
    expect(resultUrls(second)).toEqual(resultUrls(first));
  }, 180000);
});

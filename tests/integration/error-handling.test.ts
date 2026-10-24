/**
 * Error handling over stdio: each failure mode must come back as a tool error
 * with a useful message, and the server must stay usable afterwards. The old
 * version only logged whatever happened and asserted nothing.
 */
import './setup.ts';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStdioServer, callTool, callOk, type Started } from './utils.js';

describe('Error handling (stdio, live)', () => {
  let s: Started;
  beforeAll(async () => { s = await startStdioServer('error-handling'); }, 120000);
  afterAll(async () => { await s?.close(); });

  it('DNS failure is a tool error naming the lookup failure', async () => {
    const r = await callTool(s.client, 'get-single-web-page-content', { url: 'https://this-domain-does-not-exist-12345.com/page.html' }, 30000);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/ENOTFOUND|getaddrinfo/);
  });

  it('HTTP 404 is a tool error saying not found', async () => {
    const r = await callTool(s.client, 'get-single-web-page-content', { url: 'https://example.com/definitely-missing-page-xyz' }, 30000);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/404|not found/i);
  });

  it('a missing GitHub repository is a tool error saying not found', async () => {
    const r = await callTool(s.client, 'get-github-repo-content', { url: 'https://github.com/octocat/this-repo-does-not-exist-xyz' }, 30000);
    expect(r.isError).toBe(true);
    // Anonymous callers can be rate limited (403) before the 404 is reached; both are explicit refusals.
    expect(r.text).toMatch(/404|not found|403|rate limit/i);
  });

  it('a client-side timeout rejects the call, and the server still answers the next one', async () => {
    await expect(
      s.client.callTool({ name: 'get-single-web-page-content', arguments: { url: 'https://en.wikipedia.org/wiki/Web_search_engine' } },
        undefined, { timeout: 1 }),
    ).rejects.toThrow(/timed out|timeout/i);
    const text = await callOk(s.client, 'get-single-web-page-content', { url: 'https://example.com' }, 60000);
    expect(text).toContain('This domain is for use in documentation examples');
  });

  it('one failing call in a parallel batch does not affect the others', async () => {
    const [good, bad] = await Promise.all([
      callTool(s.client, 'get-single-web-page-content', { url: 'https://example.com' }, 60000),
      callTool(s.client, 'get-single-web-page-content', { url: 'https://nonexistent-domain-12345.com/page.html' }, 60000),
    ]);
    expect(good.isError).toBe(false);
    expect(good.text).toContain('**Source:** https://example.com');
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/ENOTFOUND|getaddrinfo/);
  });
});

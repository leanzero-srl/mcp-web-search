/**
 * get-github-repo-content against the real GitHub API (anonymous unless
 * GITHUB_TOKEN is set; see utils.ts for the rate-limit skip). The old version
 * never called this tool at all — it ran web searches with "github" in the
 * query and passed on any text longer than 50 characters.
 */
import './setup.ts';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStdioServer, callTool, callOk, searchIt, resultUrls, skipIfAnonymousGithubRateLimit, type Started } from './utils.js';

describe('GitHub repository tool (stdio, live)', () => {
  let s: Started;
  beforeAll(async () => { s = await startStdioServer('github'); }, 120000);
  afterAll(async () => { await s?.close(); });

  it('crawl mode returns the README of a public repository', async (ctx) => {
    const r = await callTool(s.client, 'get-github-repo-content', { url: 'https://github.com/octocat/Hello-World' }, 60000);
    skipIfAnonymousGithubRateLimit(ctx, r);
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain('**Repository:** octocat/Hello-World');
    expect(r.text).toContain('Hello World!');
  });

  it('crawl mode caps the number of files at maxFiles', async (ctx) => {
    const r = await callTool(s.client, 'get-github-repo-content', { url: 'https://github.com/microsoft/TypeScript', maxFiles: 5 }, 90000);
    skipIfAnonymousGithubRateLimit(ctx, r);
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain('# TypeScript');
    const n = Number(r.text.match(/\*\*Files \((\d+), previewLength=/)?.[1] ?? 0);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(5);
  }, 120000);

  it('list mode returns the top-level directories and files', async (ctx) => {
    const r = await callTool(s.client, 'get-github-repo-content', { url: 'https://github.com/microsoft/TypeScript', mode: 'list' }, 60000);
    skipIfAnonymousGithubRateLimit(ctx, r);
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain('**Directory listing:**');
    expect(r.text).toContain('README.md');
    expect(r.text).toContain('package.json');
  });

  it('file mode returns one file in full', async (ctx) => {
    const r = await callTool(s.client, 'get-github-repo-content',
      { url: 'https://github.com/microsoft/TypeScript', mode: 'file', path: 'README.md' }, 60000);
    skipIfAnonymousGithubRateLimit(ctx, r);
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain('**File:** microsoft/TypeScript/README.md');
    expect(r.text).toContain('# TypeScript');
  });

  it('a repository that does not exist is a "not found" tool error', async (ctx) => {
    const r = await callTool(s.client, 'get-github-repo-content', { url: 'https://github.com/octocat/this-repo-does-not-exist-xyz' }, 60000);
    skipIfAnonymousGithubRateLimit(ctx, r);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/404|not found/i);
  });

  it('two repositories fetched in parallel each come back with their own README', async (ctx) => {
    const [a, b] = await Promise.all([
      callTool(s.client, 'get-github-repo-content', { url: 'https://github.com/octocat/Hello-World', maxFiles: 2 }, 90000),
      callTool(s.client, 'get-github-repo-content', { url: 'https://github.com/octocat/Spoon-Knife', maxFiles: 2 }, 90000),
    ]);
    skipIfAnonymousGithubRateLimit(ctx, a);
    skipIfAnonymousGithubRateLimit(ctx, b);
    expect(a.text).toContain('**Repository:** octocat/Hello-World');
    expect(b.text).toContain('**Repository:** octocat/Spoon-Knife');
    expect(a.text).not.toContain('Spoon-Knife');
  }, 120000);

  searchIt('a web search for a repository finds its github.com page', async () => {
    const text = await callOk(s.client, 'full-web-search', { query: 'microsoft TypeScript github repository', limit: 3, includeContent: false });
    expect(resultUrls(text).some((u) => /github\.com\/microsoft\/TypeScript/i.test(u))).toBe(true);
  }, 120000);
});

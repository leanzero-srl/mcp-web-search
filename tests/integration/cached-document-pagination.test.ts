// Shared console redirection setup
import './setup.ts';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Offline integration: exercises read-cached-document pagination (the linchpin
// that makes large saved specs/research fully retrievable) and the new
// input-validation guards. None of these touch the network — they validate or
// read a local file before any fetch would happen.
describe('read-cached-document pagination + offline validation', () => {
  let client: Client;
  let transport: StdioClientTransport;
  const testTimeout = 30000;

  const fileName = 'research-pagination-selftest-DELETEME.md';
  const researchDir = path.join(process.cwd(), 'docs', 'research-output');
  const filePath = path.join(researchDir, fileName);
  // 240k chars in four labelled 60k blocks so page boundaries are verifiable.
  const content = 'A'.repeat(60000) + 'B'.repeat(60000) + 'C'.repeat(60000) + 'D'.repeat(60000);

  // Pin the OpenAPI cache dir so the spawned server and this test agree on where
  // specs live (module-relative resolution differs between src and dist).
  const cacheDir = path.join(os.tmpdir(), 'mcp-cache-selftest');
  const openapiDir = path.join(cacheDir, 'openapi');

  const text = (r: any): string => (r.content as any[]).find((c) => c.type === 'text')?.text || '';

  beforeAll(async () => {
    fs.mkdirSync(researchDir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    fs.mkdirSync(openapiDir, { recursive: true });

    transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      stdioBufferMaxSize: 1024 * 1024 * 50,
      env: { ...process.env, CRAWL_CACHE_DIR: cacheDir },
    } as any);
    client = new Client({ name: 'pagination-test-client', version: '1.0.0' });
    await client.connect(transport);
  }, 60000);

  afterAll(async () => {
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
    await client.close();
  });

  it('returns the first page with total size and a Next offset hint', async () => {
    const r = await client.callTool(
      { name: 'read-cached-document', arguments: { fileName, maxBytes: 50000, offset: 0 } },
      undefined, { timeout: testTimeout },
    );
    const t = text(r);
    expect(t).toContain('240000 chars total');
    expect(t).toContain('Showing chars 0');
    expect(t).toContain('Next offset: 50000');
    expect(t).toContain('A'.repeat(200));      // page 1 is all 'A'
    expect(t).not.toContain('B'.repeat(200));
  }, testTimeout);

  it('continues from a mid-document offset into different content', async () => {
    const r = await client.callTool(
      { name: 'read-cached-document', arguments: { fileName, maxBytes: 50000, offset: 60000 } },
      undefined, { timeout: testTimeout },
    );
    const t = text(r);
    expect(t).toContain('Showing chars 60000');
    expect(t).toContain('B'.repeat(200));
    expect(t).not.toContain('A'.repeat(200));
  }, testTimeout);

  it('pages through the whole document and reconstructs it exactly', async () => {
    let assembled = '';
    let offset = 0;
    let guard = 0;
    let endedCleanly = false;
    while (guard++ < 50) {
      const r = await client.callTool(
        { name: 'read-cached-document', arguments: { fileName, maxBytes: 50000, offset } },
        undefined, { timeout: testTimeout },
      );
      const t = text(r);
      const body = t.match(/```markdown\n([\s\S]*?)\n```/);
      assembled += body ? body[1] : '';
      const next = t.match(/Next offset: (\d+)/);
      if (!next) { endedCleanly = t.includes('End of document reached'); break; }
      offset = parseInt(next[1], 10);
    }
    expect(endedCleanly).toBe(true);
    expect(assembled.length).toBe(240000);
    expect(assembled).toBe(content);
  }, 60000);

  it('a single large page (maxBytes=200000) is not re-clipped by the safety net', async () => {
    const r = await client.callTool(
      { name: 'read-cached-document', arguments: { fileName, maxBytes: 200000, offset: 0 } },
      undefined, { timeout: testTimeout },
    );
    const t = text(r);
    const body = t.match(/```markdown\n([\s\S]*?)\n```/);
    expect(body?.[1].length).toBe(200000);
    expect(t).not.toContain('Response truncated');
  }, testTimeout);

  it('reads back an OpenAPI spec from the extractor cache dir (path-consistency regression)', async () => {
    // Regression: get-openapi-spec saves specs via the module-relative cache
    // dir, but read-cached-document used to recompute a cwd-relative path and
    // could "lose" them. They must resolve to the same directory (here pinned via
    // CRAWL_CACHE_DIR). We write a spec into that dir and confirm
    // read-cached-document finds it — no network needed.
    const specName = 'selftest-petstore-DELETEME.json';
    const specPath = path.join(openapiDir, specName);
    fs.writeFileSync(specPath, JSON.stringify({ openapi: '3.0.0', info: { title: 'Self Test', version: '1' }, paths: {} }), 'utf8');
    try {
      const r = await client.callTool(
        { name: 'read-cached-document', arguments: { fileName: specName } },
        undefined, { timeout: testTimeout },
      );
      const t = text(r);
      expect(t).toContain('(openapi,');
      expect(t).toContain('Self Test');
      expect(t).not.toContain('Document not found');
    } finally {
      try { fs.unlinkSync(specPath); } catch { /* ignore */ }
    }
  }, testTimeout);

  it('rejects limit=0 on get-website-sitemap (offline validation)', async () => {
    const r = await client.callTool(
      { name: 'get-website-sitemap', arguments: { url: 'https://example.com', limit: 0 } },
      undefined, { timeout: testTimeout },
    );
    expect(r.isError).toBe(true);
  }, testTimeout);

  it('rejects a junk numeric string limit on full-web-search (offline validation)', async () => {
    // The typed Zod schema (limit: number) rejects a string at the protocol
    // layer, so the call is refused outright rather than returning isError.
    await expect(client.callTool(
      { name: 'full-web-search', arguments: { query: 'anything', limit: '5abc' } },
      undefined, { timeout: testTimeout },
    )).rejects.toThrow();
  }, testTimeout);

  it('rejects path traversal on get-github-repo-content (offline validation)', async () => {
    const r = await client.callTool(
      { name: 'get-github-repo-content', arguments: { url: 'https://github.com/owner/repo', mode: 'file', path: '../../etc/passwd' } },
      undefined, { timeout: testTimeout },
    );
    expect(r.isError).toBe(true);
  }, testTimeout);
});

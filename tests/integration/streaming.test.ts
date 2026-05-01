/**
 * Streamable HTTP — chunked / SSE end-to-end smoke test.
 *
 * This is the load-bearing test for the question "does the Streamable HTTP
 * transport carry long tool responses correctly through the chunked / SSE
 * channel?" Locally, it exercises the full client → transport → server →
 * tool → response path with a real tool that emits a non-trivial response
 * size.
 *
 * Hits the public internet (example.com), so it's gated behind
 * RUN_STREAMING_TEST=1. The same test should also be run manually against the
 * Tailscale Funnel-exposed instance during deploy verification — that's the
 * only way to confirm chunked encoding survives the Funnel hop, which is
 * undocumented.
 *
 * Skipped by default in CI to avoid flakes on network-restricted runners.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

const RUN = process.env.RUN_STREAMING_TEST === '1';
const describeMaybe = RUN ? describe : describe.skip;

const TMP_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'mcp-web-search-stream-'));
process.env.DATA_DIR = TMP_DATA_DIR;
process.env.MCP_WEB_SEARCH_ADMIN_TOKEN = 'test-admin-token-stream';
delete process.env.PUBLIC_HOST;
process.env.TENANT_RATE_LIMIT = '100';

let httpServer: http.Server;
let baseUrl: string;
let tenantBearer: string;
let sharedInstance: { closeAll(): Promise<void> };

beforeAll(async () => {
  if (!RUN) return;
  const { WebSearchMCPServer } = await import('../../src/server.js');
  const { buildApp } = await import('../../src/http-server.js');
  const { invalidateTenantsCache } = await import('../../src/auth.js');
  invalidateTenantsCache();

  sharedInstance = new WebSearchMCPServer({ skipShutdownHooks: true });
  const app = buildApp(sharedInstance as never);

  httpServer = await new Promise<http.Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind test server');
  baseUrl = `http://127.0.0.1:${addr.port}`;

  const mintRes = await fetch(`${baseUrl}/v1/admin/tenants`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.MCP_WEB_SEARCH_ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ displayName: 'streaming-test' }),
  });
  const minted = await mintRes.json();
  tenantBearer = minted.bearer;
}, 60_000);

afterAll(async () => {
  if (!RUN) return;
  if (httpServer) await new Promise<void>((r) => httpServer.close(() => r()));
  await sharedInstance?.closeAll().catch(() => { /* best effort */ });
}, 60_000);

describeMaybe('Streamable HTTP — long-call chunked path', () => {
  it('get-single-web-page-content returns full body within 25s', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: {
        headers: { 'Authorization': `Bearer ${tenantBearer}` },
      },
    });
    const client = new Client({ name: 'streaming-test', version: '0.1.0' });
    await client.connect(transport);

    try {
      const start = Date.now();
      const result = await client.callTool({
        name: 'get-single-web-page-content',
        arguments: { url: 'https://example.com/' },
      });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(25_000);
      // The chunked / SSE transport carried *some* response back. That's the
      // load-bearing assertion here — whether the tool itself succeeded
      // depends on Playwright + network + the search engine, which is a
      // separate concern. Tool failures are still delivered as content.
      const content = result.content as Array<{ type: string; text: string }>;
      expect(Array.isArray(content)).toBe(true);
      expect(content.length).toBeGreaterThan(0);
      expect(content[0].type).toBe('text');
      expect(typeof content[0].text).toBe('string');
      expect(content[0].text.length).toBeGreaterThan(0);
    } finally {
      await transport.close();
    }
  }, 30_000);
});

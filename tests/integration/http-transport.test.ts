/**
 * HTTP transport end-to-end tests using the official SDK client.
 *
 * Boots the express app on a random port, mints a tenant bearer via the admin
 * surface, then drives a Streamable-HTTP MCP client through `initialize` and
 * `tools/list`. This is the regression test for the refactor that extracted
 * `registerToolsOn(target)` from the old `setupTools()`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'mcp-web-search-http-'));
process.env.DATA_DIR = TMP_DATA_DIR;
process.env.MCP_WEB_SEARCH_ADMIN_TOKEN = 'test-admin-token-http';
// Intentionally NOT setting PUBLIC_HOST: that's a deploy concern. Locally we
// bind to a random port and the host header would include the port, which
// would fail any allowedHosts match.
delete process.env.PUBLIC_HOST;
process.env.TENANT_RATE_LIMIT = '100';

let httpServer: http.Server;
let baseUrl: string;
let tenantBearer: string;
let sharedInstance: { closeAll(): Promise<void> };

beforeAll(async () => {
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
    body: JSON.stringify({ displayName: 'http-test-tenant' }),
  });
  expect(mintRes.status).toBe(201);
  const minted = await mintRes.json();
  tenantBearer = minted.bearer;
  expect(tenantBearer).toBeTruthy();
}, 60_000);

afterAll(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer.close(() => r()));
  await sharedInstance.closeAll().catch(() => { /* best effort */ });
}, 30_000);

async function newMcpClient(): Promise<{ client: any; transport: any }> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: {
      headers: { 'Authorization': `Bearer ${tenantBearer}` },
    },
  });
  const client = new Client({ name: 'http-test', version: '0.1.0' });
  await client.connect(transport);
  return { client, transport };
}

describe('HTTP transport — health probe', () => {
  it('GET /healthz returns ok with tools count', async () => {
    const r = await fetch(`${baseUrl}/healthz`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.tools).toBe(11);
    expect(body.version).toBeTruthy();
  });
});

describe('HTTP transport — MCP protocol over SDK Client', () => {
  it('initialize returns server identity', async () => {
    const { client, transport } = await newMcpClient();
    try {
      const info = client.getServerVersion();
      expect(info.name).toBe('web-search-mcp');
      expect(info.version).toBe('0.3.1');
    } finally {
      await transport.close();
    }
  });

  it('tools/list returns all 11 advertised tools', async () => {
    const { client, transport } = await newMcpClient();
    try {
      const result = await client.listTools();
      const names = (result.tools as Array<{ name: string }>).map((t) => t.name).sort();
      const expected = [
        'full-web-search',
        'get-github-repo-content',
        'get-openapi-spec',
        'get-pdf-content',
        'get-single-web-page-content',
        'get-web-search-summaries',
        'get-website-sitemap',
        'list-cached-documents',
        'progressive-web-search',
        'read-cached-document',
        'research_and_save_to_markdown',
      ];
      expect(names).toEqual(expected);
    } finally {
      await transport.close();
    }
  });

  it('tools/call list-cached-documents works end-to-end (no network)', async () => {
    // list-cached-documents is the cheapest tool to round-trip — pure local
    // filesystem read of crawl-cache.json with no external API calls.
    const { client, transport } = await newMcpClient();
    try {
      const result = await client.callTool({
        name: 'list-cached-documents',
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(Array.isArray(content)).toBe(true);
      expect(content[0].type).toBe('text');
    } finally {
      await transport.close();
    }
  });
});

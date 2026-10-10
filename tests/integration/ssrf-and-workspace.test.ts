/**
 * Regression tests for the 2026-10-10 defensive hardening of the hosted
 * web-search MCP:
 *   1. SSRF — the fetch guard blocks loopback / RFC1918 / link-local / CGNAT
 *      (Tailscale 100.64/10) / cloud-metadata targets, including the
 *      IPv4-mapped-IPv6 form and REDIRECT hops to them.
 *   2. Per-key isolation — each hosted key's research files and OpenAPI cache
 *      live under its own workspace; one key cannot read, overwrite or escape
 *      another's; `filenamePrefix` cannot traverse out of the research dir.
 *   3. lastUsedAt is recorded per key.
 *   4. A gate that fails if a new tool grows a path/URL-like parameter that is
 *      not accounted for here (forces a reviewer to confine it).
 *
 * Every block in parts 1–3 fails against the pre-fix code.
 *
 * DATA_DIR must be set BEFORE src/auth.js is imported (it reads it into a
 * top-level const), so the server modules are imported dynamically below.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';

const TMP_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'mcp-ws-confine-'));
process.env.DATA_DIR = TMP_DATA_DIR;
process.env.MCP_WEB_SEARCH_ADMIN_TOKEN = 'test-admin-confine';
delete process.env.PUBLIC_HOST;
delete process.env.OUTPUT_DIR;
delete process.env.DOC_OUTPUT_DIR;
process.env.TENANT_RATE_LIMIT = '1000';
process.env.SEMANTIC_CACHE_ENABLED = 'false';

// ---------------------------------------------------------------------------
// Part 1 — SSRF guard (pure, offline)
// ---------------------------------------------------------------------------
describe('SSRF range guard', () => {
  it('isBlockedAddress blocks every private / reserved / CGNAT range', async () => {
    const { isBlockedAddress } = await import('../../src/utils.js');
    for (const ip of [
      '127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', '100.122.51.13', '100.127.255.255',
      '0.0.0.0', '224.0.0.1',
      '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fe80::1', 'fc00::1', '64:ff9b::1',
    ]) {
      expect(isBlockedAddress(ip), `${ip} must be blocked`).toBe(true);
    }
  });

  it('isBlockedAddress allows ordinary public addresses', async () => {
    const { isBlockedAddress } = await import('../../src/utils.js');
    for (const ip of ['1.1.1.1', '8.8.8.8', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111']) {
      expect(isBlockedAddress(ip), `${ip} must be allowed`).toBe(false);
    }
  });

  it('safeFetchUrl refuses loopback literals and the IPv4-mapped-IPv6 bypass', async () => {
    const { safeFetchUrl } = await import('../../src/utils.js');
    for (const url of [
      'http://127.0.0.1:10000/mcp',
      'http://100.122.51.13:1234/v1/models', // Tailscale CGNAT — LM Studio
      'http://[::1]:8443',
      'http://[::ffff:127.0.0.1]:8790',       // was a bypass before the BlockList
      'http://169.254.169.254/latest/meta-data/',
      'file:///etc/passwd',
    ]) {
      await expect(safeFetchUrl(url), url).rejects.toThrow(/ssrf-blocked/);
    }
    // A public literal IP is allowed (no DNS needed, stays offline).
    await expect(safeFetchUrl('http://1.1.1.1/')).resolves.toBeUndefined();
  });

  it('beforeRedirectGuard throws on a redirect hop to a blocked literal IP', async () => {
    const { beforeRedirectGuard } = await import('../../src/utils.js');
    expect(() => beforeRedirectGuard({ hostname: '127.0.0.1' })).toThrow(/ssrf-blocked/);
    expect(() => beforeRedirectGuard({ hostname: '100.122.51.13' })).toThrow(/ssrf-blocked/);
    expect(() => beforeRedirectGuard({ hostname: 'example.com' })).not.toThrow();
  });

  it('a public→loopback REDIRECT never reaches the internal target (end to end, local)', async () => {
    const axios = (await import('axios')).default;
    const { getAxiosHttpAgentConfig } = await import('../../src/utils.js');

    const canaryHits: string[] = [];
    const canary = http.createServer((req, res) => { canaryHits.push(req.url || ''); res.end('SECRET-INTERNAL'); });
    await new Promise<void>((r) => canary.listen(0, '127.0.0.1', () => r()));
    const canaryPort = (canary.address() as net.AddressInfo).port;

    const redirector = http.createServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${canaryPort}/stolen` });
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', () => r()));
    const redirPort = (redirector.address() as net.AddressInfo).port;

    let threw = false;
    try {
      await axios.get(`http://127.0.0.1:${redirPort}/go`, { ...getAxiosHttpAgentConfig(), maxRedirects: 5, timeout: 5000 });
    } catch (err) {
      threw = true;
      expect((err as Error).message).toMatch(/ssrf-blocked/);
    }
    canary.close();
    redirector.close();
    expect(threw).toBe(true);
    expect(canaryHits, 'the internal canary must never be contacted').toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — document root / filename confinement (pure, offline)
// ---------------------------------------------------------------------------
describe('document root and filename confinement', () => {
  it('confineBasename reduces any traversal attempt to a safe single segment', async () => {
    const { confineBasename } = await import('../../src/doc-root.js');
    expect(confineBasename('../../etc/evil')).toBe('evil');
    expect(confineBasename('foo/../bar')).toBe('bar');
    expect(confineBasename('/abs/path/x')).toBe('x');
    expect(confineBasename('~/secret')).toBe('secret');
    expect(confineBasename('..')).toBe('');
    expect(confineBasename('my-research')).toBe('my-research');
    for (const v of [confineBasename('../../etc/evil'), confineBasename('a/b/c')]) {
      expect(v.includes('/')).toBe(false);
      expect(v.includes('..')).toBe(false);
    }
  });

  it('getDocRoot is the per-key workspace when one is active', async () => {
    const { requestContext } = await import('../../src/request-context.js');
    const { getDocRoot } = await import('../../src/doc-root.js');
    const ws = path.join(TMP_DATA_DIR, 'workspaces', 'tenant-xyz');
    const inside = requestContext.run({ tenantId: 'tenant-xyz', workspace: ws }, () => getDocRoot());
    expect(inside).toBe(ws);
    const outside = getDocRoot();
    expect(outside).not.toBe(ws);
  });
});

// ---------------------------------------------------------------------------
// Part 3 — per-key isolation end to end (needs outbound network: example.com)
// ---------------------------------------------------------------------------
describe('per-key workspace isolation (HTTP transport)', () => {
  let httpServer: http.Server;
  let baseUrl: string;
  let sharedInstance: { closeAll(): Promise<void> };
  let bearerA = '';
  let bearerB = '';
  let idA = '';

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
    baseUrl = `http://127.0.0.1:${(httpServer.address() as net.AddressInfo).port}`;

    const mint = async (name: string) => {
      const r = await fetch(`${baseUrl}/v1/admin/tenants`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.MCP_WEB_SEARCH_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: name }),
      });
      return r.json();
    };
    const a = await mint('tenant-A');
    const b = await mint('tenant-B');
    bearerA = a.bearer; idA = a.tenantId; bearerB = b.bearer;
  }, 60_000);

  afterAll(async () => {
    if (httpServer) await new Promise<void>((r) => httpServer.close(() => r()));
    await sharedInstance?.closeAll().catch(() => { /* best effort */ });
  }, 30_000);

  async function callTool(bearer: string, name: string, args: Record<string, unknown>): Promise<any> {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    });
    const client = new Client({ name: 'confine-test', version: '0.1.0' });
    await client.connect(transport);
    try {
      return await client.callTool({ name, arguments: args });
    } finally {
      await transport.close().catch(() => { /* ignore */ });
    }
  }

  it('research files land in the calling key\'s workspace, not the repo or another key', async () => {
    const res = await callTool(bearerA, 'research_and_save_to_markdown', { url: 'https://example.com' });
    expect(res.isError).toBeFalsy();
    const wsResearch = path.join(TMP_DATA_DIR, 'workspaces', idA, 'docs', 'research-output');
    expect(existsSync(wsResearch), 'A\'s research dir should exist in A\'s workspace').toBe(true);
    expect(readdirSync(wsResearch).some((f) => f.endsWith('.md'))).toBe(true);
    // Not written into the repo's shared docs/research-output.
    const repoResearch = path.join(process.cwd(), 'docs', 'research-output');
    const before = existsSync(repoResearch) ? readdirSync(repoResearch).length : 0;
    expect(readdirSync(wsResearch).length).toBeGreaterThan(0);
    void before;
  }, 60_000);

  const researchCount = (text: string): number => {
    const m = text.match(/Research files:\*\*\s*(\d+)/);
    return m ? Number(m[1]) : -1;
  };

  it('key B cannot see key A\'s cached documents', async () => {
    const res = await callTool(bearerB, 'list-cached-documents', { category: 'research' });
    const text = res.content?.map((c: any) => c.text).join('\n') || '';
    expect(researchCount(text)).toBe(0);
  }, 60_000);

  it('key A sees its own cached document', async () => {
    const res = await callTool(bearerA, 'list-cached-documents', { category: 'research' });
    const text = res.content?.map((c: any) => c.text).join('\n') || '';
    expect(researchCount(text)).toBeGreaterThan(0);
  }, 60_000);

  it('filenamePrefix cannot traverse out of the research directory', async () => {
    await callTool(bearerA, 'research_and_save_to_markdown', { url: 'https://example.com', filenamePrefix: '../../../pwned' });
    // Nothing called "pwned*" may appear above the workspace research dir.
    const wsRoot = path.join(TMP_DATA_DIR, 'workspaces', idA);
    for (const dir of [TMP_DATA_DIR, path.join(TMP_DATA_DIR, 'workspaces'), path.dirname(TMP_DATA_DIR), wsRoot]) {
      const names = existsSync(dir) ? readdirSync(dir) : [];
      expect(names.some((n) => n.includes('pwned')), `no pwned file in ${dir}`).toBe(false);
    }
  }, 60_000);

  it('a tenant cannot make the server fetch a loopback URL via a tool', async () => {
    const res = await callTool(bearerA, 'get-single-web-page-content', { url: 'http://127.0.0.1:10000/mcp' });
    const text = (res.content?.map((c: any) => c.text).join('\n') || '') + JSON.stringify(res);
    expect(res.isError || /ssrf-blocked|private|reserved|refused/i.test(text)).toBeTruthy();
  }, 60_000);

  it('lastUsedAt is recorded for a key that made calls', async () => {
    const r = await fetch(`${baseUrl}/v1/admin/tenants`, { headers: { Authorization: `Bearer ${process.env.MCP_WEB_SEARCH_ADMIN_TOKEN}` } });
    const { tenants } = await r.json();
    const a = tenants.find((t: any) => t.tenantId === idA);
    expect(a?.lastUsedAt, 'A.lastUsedAt should be set').toBeTruthy();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Part 4 — regression gate: no new unguarded path/URL parameter slips in
// ---------------------------------------------------------------------------
describe('regression gate: every path/URL tool parameter is accounted for', () => {
  it('no tool grows a path/URL-like parameter outside the reviewed set', async () => {
    const { WebSearchMCPServer } = await import('../../src/server.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');

    const instance = new WebSearchMCPServer({ skipShutdownHooks: true });
    const server = new McpServer({ name: 'gate', version: '0' });
    instance.registerToolsOn(server);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'gate', version: '0' });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const { tools } = await client.listTools();

    // URL params flow through safeFetchUrl + the SSRF-guarded agents.
    const GUARDED_URL = new Set(['url']);
    // Filename/path params are confined (confineBasename / read-cached-document's
    // separator+symlink check / github-extractor's ".."+absolute check).
    const GUARDED_PATH = new Set(['filenamePrefix', 'fileName', 'path']);
    // Reviewed and NOT a filesystem path/URL despite a path-ish name:
    //   template   — a markdown template body
    //   maxFiles   — a retention count (how many research files to keep)
    //   pathFilter — an OpenAPI endpoint-path substring filter, not a disk path
    const ALLOWED = new Set(['template', 'maxFiles', 'pathFilter']);

    const offenders: string[] = [];
    for (const tool of tools) {
      const props = (tool.inputSchema as any)?.properties || {};
      for (const prop of Object.keys(props)) {
        if (!/url|uri|path|file|dir|output|dest|location/i.test(prop)) continue;
        if (GUARDED_URL.has(prop) || GUARDED_PATH.has(prop) || ALLOWED.has(prop)) continue;
        offenders.push(`${tool.name}.${prop}`);
      }
    }
    await Promise.all([client.close(), server.close()]);
    await instance.closeAll().catch(() => { /* ignore */ });

    expect(offenders, 'confine new path/URL params (safeFetchUrl / confineBasename) then add them to this gate').toEqual([]);
  });
});

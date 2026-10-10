/**
 * Hosted key lifecycle (2026-10-10, follow-up to 12635ca):
 *   1. Revoking a key moves its workspace out of service at once (kept under
 *      <DATA_DIR>/revoked-workspaces for REVOKED_WORKSPACE_RETENTION_DAYS, then
 *      deleted) and drops its memoised crawl cache. Before: the folder stayed
 *      on disk forever.
 *   2. Per-key disk cap (WORKSPACE_QUOTA_MB): a full workspace refuses the
 *      file-writing tools with a clear error; reading/listing and other keys
 *      are unaffected. Before: no cap at all.
 *   3. A key whose id is not a plain UUID (e.g. an OAuth sub "oauth:auth0|123")
 *      still gets its own workspace. Before: workspaceForTenant threw and the
 *      request ran with NO workspace — on the operator's shared directories.
 *   4. Gate: every tool is classified as writing files or not.
 *
 * DATA_DIR must be set BEFORE src/auth.js is imported (top-level const).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';

const TMP_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'mcp-ws-lifecycle-'));
process.env.DATA_DIR = TMP_DATA_DIR;
process.env.MCP_WEB_SEARCH_ADMIN_TOKEN = 'test-admin-lifecycle';
process.env.PROVISION_SECRET = 'test-provision-lifecycle';
process.env.WORKSPACE_QUOTA_MB = '0.25'; // 256 KiB, so the test can fill it
delete process.env.REVOKED_WORKSPACE_RETENTION_DAYS; // default 7 days
delete process.env.PUBLIC_HOST;
delete process.env.OUTPUT_DIR;
delete process.env.DOC_OUTPUT_DIR;
process.env.TENANT_RATE_LIMIT = '1000';
process.env.SEMANTIC_CACHE_ENABLED = 'false';

const WS_BASE = path.join(TMP_DATA_DIR, 'workspaces');
const REVOKED_BASE = path.join(TMP_DATA_DIR, 'revoked-workspaces');
const ADMIN = { Authorization: `Bearer ${process.env.MCP_WEB_SEARCH_ADMIN_TOKEN}`, 'Content-Type': 'application/json' };

let httpServer: http.Server;
let baseUrl: string;
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
  baseUrl = `http://127.0.0.1:${(httpServer.address() as net.AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer.close(() => r()));
  await sharedInstance?.closeAll().catch(() => { /* best effort */ });
  rmSync(TMP_DATA_DIR, { recursive: true, force: true });
}, 30_000);

async function mint(name: string): Promise<{ tenantId: string; bearer: string }> {
  const r = await fetch(`${baseUrl}/v1/admin/tenants`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ displayName: name }) });
  return r.json();
}

let rpcId = 0;
async function call(bearer: string, name: string, args: Record<string, unknown>): Promise<{ status: number; isError: boolean; text: string }> {
  const r = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await r.text();
  let msg: any = null;
  for (const line of raw.split('\n')) if (line.startsWith('data:')) msg = JSON.parse(line.slice(5));
  if (!msg) { try { msg = JSON.parse(raw); } catch { msg = { raw }; } }
  const text = (msg.result?.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') || JSON.stringify(msg.error || msg);
  return { status: r.status, isError: !!msg.result?.isError || !msg.result, text };
}

const researchCount = (text: string): number => {
  const m = text.match(/Research files:\*\*\s*(\d+)/);
  return m ? Number(m[1]) : -1;
};
const archivesOf = (name: string): string[] => (existsSync(REVOKED_BASE) ? readdirSync(REVOKED_BASE) : []).filter((n) => n.startsWith(`${name}--`));

describe('revoking a key takes its workspace out of service', () => {
  it('admin revoke archives the folder, drops the memoised crawl cache, and kills the key', async () => {
    const k = await mint('revoke-admin');
    const before = await call(k.bearer, 'list-cached-documents', { category: 'all' });
    expect(before.isError).toBe(false);
    const live = path.join(WS_BASE, k.tenantId);
    expect(existsSync(live), 'positive control: the workspace existed').toBe(true);
    writeFileSync(path.join(live, 'note.md'), 'kept for the retention period');

    const { getCrawlCacheForRoot } = await import('../../src/crawl-cache.js');
    const { realpathSync } = await import('node:fs');
    const memo = getCrawlCacheForRoot(realpathSync(live));

    const del = await fetch(`${baseUrl}/v1/admin/tenants/${k.tenantId}`, { method: 'DELETE', headers: ADMIN });
    expect(del.status).toBe(200);
    expect(existsSync(live), 'the live workspace folder must be gone').toBe(false);
    const archives = archivesOf(k.tenantId);
    expect(archives.length).toBe(1);
    expect(readFileSync(path.join(REVOKED_BASE, archives[0], 'note.md'), 'utf8')).toBe('kept for the retention period');
    // A fresh lookup for the old live path is a NEW instance (the stale one was dropped).
    expect(getCrawlCacheForRoot(path.join(realpathSync(TMP_DATA_DIR), 'workspaces', k.tenantId)) === memo, 'stale crawl cache must be forgotten').toBe(false);
    rmSync(live, { recursive: true, force: true }); // the lookup above recreated an empty dir via CrawlCache init

    const after = await call(k.bearer, 'list-cached-documents', {});
    expect(after.status).toBe(401);
  });

  it('self-service revoke (/v1/provision) does the same', async () => {
    const r = await fetch(`${baseUrl}/v1/provision`, {
      method: 'POST',
      headers: { 'X-Provision-Secret': process.env.PROVISION_SECRET as string, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'revoke-provision' }),
    });
    const k = await r.json();
    await call(k.bearer, 'list-cached-documents', {});
    expect(existsSync(path.join(WS_BASE, k.tenantId))).toBe(true);
    const del = await fetch(`${baseUrl}/v1/provision/${k.tenantId}`, { method: 'DELETE', headers: { 'X-Provision-Secret': process.env.PROVISION_SECRET as string } });
    expect(del.status).toBe(200);
    expect(existsSync(path.join(WS_BASE, k.tenantId))).toBe(false);
    expect(archivesOf(k.tenantId).length).toBe(1);
  });

  it('archives are deleted once the retention runs out, not before', async () => {
    const { purgeExpiredRevokedWorkspaces } = await import('../../src/doc-root.js');
    const count = readdirSync(REVOKED_BASE).length;
    expect(count).toBeGreaterThanOrEqual(2);
    expect(purgeExpiredRevokedWorkspaces(Date.now() + 6 * 24 * 3600 * 1000)).toEqual([]);
    expect(purgeExpiredRevokedWorkspaces(Date.now() + 8 * 24 * 3600 * 1000).length).toBe(count);
    expect(readdirSync(REVOKED_BASE).length).toBe(0);
  });
});

describe('per-key disk cap', () => {
  it('a full workspace refuses the file-writing tools, keeps listing, and leaves other keys alone', async () => {
    const full = await mint('fills-its-quota');
    await call(full.bearer, 'list-cached-documents', {});
    writeFileSync(path.join(WS_BASE, full.tenantId, 'filler.bin'), Buffer.alloc(300 * 1024));

    for (const [tool, args] of [
      ['research_and_save_to_markdown', { url: 'https://example.com' }],
      ['get-openapi-spec', { url: 'https://petstore3.swagger.io/api/v3/openapi.json' }],
    ] as const) {
      const r = await call(full.bearer, tool, args as Record<string, unknown>);
      expect(r.isError, `${tool} must be refused`).toBe(true);
      expect(r.text).toMatch(/Workspace full: this key's files use [\d.]+ MB of its [\d.]+ MB limit/);
    }
    const written = (readdirSync(path.join(WS_BASE, full.tenantId), { recursive: true }) as string[])
      .filter((f) => /\.(md|json)$/.test(String(f)) && !String(f).endsWith('crawl-cache.json'));
    expect(written, 'nothing was written').toEqual([]);
    const list = await call(full.bearer, 'list-cached-documents', { category: 'all' });
    expect(list.isError).toBe(false);

    const other = await mint('has-room');
    const ok = await call(other.bearer, 'research_and_save_to_markdown', { url: 'https://example.com' });
    expect(ok.text).not.toMatch(/Workspace full/);
    expect(ok.isError).toBe(false);

    rmSync(path.join(WS_BASE, full.tenantId, 'filler.bin'));
    const again = await call(full.bearer, 'research_and_save_to_markdown', { url: 'https://example.com' });
    expect(again.text).not.toMatch(/Workspace full/);
  }, 120_000);
});

describe('a key with a non-UUID id still gets its own workspace (fail closed)', () => {
  it('an OAuth-style id is mapped to a hashed workspace instead of running unconfined', async () => {
    const argon2 = (await import('argon2')).default;
    const { invalidateTenantsCache } = await import('../../src/auth.js');
    const { workspaceDirName } = await import('../../src/doc-root.js');
    const odd = 'oauth:auth0|user-123';
    const bearer = 'odd-tenant-bearer-0123456789abcdef';
    const tenantsPath = path.join(TMP_DATA_DIR, 'tenants.json');
    const tenants = existsSync(tenantsPath) ? JSON.parse(readFileSync(tenantsPath, 'utf8')) : {};
    tenants[odd] = { displayName: 'odd', bearerHash: await argon2.hash(bearer, { type: argon2.argon2id }), expiringHashes: [], createdAt: new Date().toISOString(), lastUsedAt: null };
    writeFileSync(tenantsPath, JSON.stringify(tenants));
    invalidateTenantsCache();

    // Positive control: the operator's own (stdio) research dir is NOT empty here,
    // so an unconfined call would list it.
    const operatorResearch = path.join(process.cwd(), 'docs', 'research-output');
    const operatorHasFiles = existsSync(operatorResearch) && readdirSync(operatorResearch).some((f) => f.endsWith('.md'));
    if (!operatorHasFiles) {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(operatorResearch, { recursive: true });
      writeFileSync(path.join(operatorResearch, 'operator-canary-lifecycle.md'), '# operator file');
    }
    try {
      const r = await call(bearer, 'list-cached-documents', { category: 'research' });
      expect(r.status).toBe(200);
      expect(researchCount(r.text), `the odd key must see only its own (empty) workspace: ${r.text.slice(0, 200)}`).toBe(0);
      const dir = workspaceDirName(odd);
      expect(dir).toMatch(/^h-[0-9a-f]{40}$/);
      expect(existsSync(path.join(WS_BASE, dir))).toBe(true);
    } finally {
      if (!operatorHasFiles) rmSync(path.join(operatorResearch, 'operator-canary-lifecycle.md'), { force: true });
    }
  });
});

describe('gate: every tool is classified as file-writing or not', () => {
  it('WRITE_TOOLS ∪ NO_FILE_WRITE_TOOLS covers every registered tool', async () => {
    const { WRITE_TOOLS, NO_FILE_WRITE_TOOLS } = await import('../../src/http-server.js');
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
    await Promise.all([client.close(), server.close()]);
    await instance.closeAll().catch(() => { /* ignore */ });
    const unclassified = tools.map((t) => t.name).filter((n) => !WRITE_TOOLS.has(n) && !NO_FILE_WRITE_TOOLS.has(n));
    expect(unclassified, 'add the new tool to WRITE_TOOLS (it writes files) or NO_FILE_WRITE_TOOLS in src/http-server.ts').toEqual([]);
  });
});

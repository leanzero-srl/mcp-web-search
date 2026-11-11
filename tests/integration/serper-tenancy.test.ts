/**
 * Serper credits belong to us (2026-11-11).
 *
 * The hosted server used to fall back to process.env.SERPER_API_KEY when a
 * caller sent none, every key was the same kind, and nothing counted how many
 * upstream Serper requests (credits) each key spent. This suite proves:
 *   - tenant class 'public' (default, provisioned) | 'internal' (admin only)
 *   - public keys spend ONLY their own X-Serper-Key, never the server env key
 *   - internal keys spend the server-side key from INTERNAL_SERPER_KEY_FILE,
 *     ignore a caller key, refuse a group/other-readable key file, and fail
 *     clearly (no silent fallback) when the file is missing
 *   - internal keys are refused over the public Funnel, allowed on loopback
 *   - separate per-minute rate limits per class
 *   - every upstream Serper request is metered by tenant/class/keySource and
 *     shown in GET /v1/admin/usage (no keys or hashes in it), persisted to disk
 *   - per-key monthly caps and global budgets refuse with a plain isError
 *
 * Upstream Serper is never called: axios.post / axios.get are stubbed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import type http from 'node:http';
import request from 'supertest';
import axios from 'axios';

const TMP = mkdtempSync(path.join(tmpdir(), 'mcp-ws-tenancy-'));
const ADMIN = 'test-admin-tenancy';
const ENV_KEY = 'env-serper-key-must-never-be-used';
const OWN_KEY = 'own-site-serper-key';
const INTERNAL_KEY = 'internal-server-serper-key';
const KEY_FILE = path.join(TMP, 'internal-serper.key');

process.env.DATA_DIR = TMP;
process.env.MCP_WEB_SEARCH_ADMIN_TOKEN = ADMIN;
process.env.SERPER_API_KEY = ENV_KEY; // the hole: public callers must never reach this
process.env.OWN_SERPER_KEY_SHA256 = createHash('sha256').update(OWN_KEY).digest('hex');
process.env.TENANT_RATE_LIMIT = '1000';
process.env.INTERNAL_TENANT_RATE_LIMIT = '1000';
process.env.SEMANTIC_CACHE_ENABLED = 'false';
process.env.USE_SERPER_ONLY = 'true';
process.env.USAGE_FLUSH_MS = '20';
delete process.env.PUBLIC_HOST;
delete process.env.INTERNAL_SERPER_KEY_FILE;
delete process.env.INTERNAL_TAILNET_ONLY;

let app: any;
let server: http.Server;
let baseUrl: string;
let shared: { closeAll(): Promise<void> };
const keysSent: string[] = [];
let accountCalls = 0;

function writeKeyFile(mode = 0o600): void {
  writeFileSync(KEY_FILE, INTERNAL_KEY + '\n');
  chmodSync(KEY_FILE, mode);
}

beforeAll(async () => {
  vi.spyOn(axios, 'post').mockImplementation(async (url: string, _body: unknown, cfg: any) => {
    if (String(url).includes('serper.dev')) {
      keysSent.push(cfg?.headers?.['X-API-KEY']);
      return { data: { organic: [{ title: 'Stub result', link: 'https://example.com/stub', snippet: 'stub' }] } } as any;
    }
    throw new Error('unexpected axios.post ' + url);
  });
  vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
    if (String(url).includes('serper.dev/account')) {
      accountCalls++;
      return { data: { balance: 12345, rateLimit: 50 } } as any;
    }
    throw new Error('unexpected axios.get ' + url);
  });
  const { WebSearchMCPServer } = await import('../../src/server.js');
  const { buildApp } = await import('../../src/http-server.js');
  shared = new WebSearchMCPServer({ skipShutdownHooks: true });
  app = buildApp(shared as never);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
});

afterAll(async () => {
  server?.close();
  await shared?.closeAll().catch(() => {});
  rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  keysSent.length = 0;
  for (const k of ['PUBLIC_MONTHLY_SERPER_CAP', 'INTERNAL_MONTHLY_SERPER_CAP', 'OWN_DAILY_BUDGET', 'OWN_MONTHLY_BUDGET',
    'INTERNAL_DAILY_BUDGET', 'INTERNAL_MONTHLY_BUDGET']) delete process.env[k];
});

async function mint(displayName: string, cls?: string): Promise<{ tenantId: string; bearer: string; class?: string }> {
  const res = await request(app).post('/v1/admin/tenants').set('Authorization', `Bearer ${ADMIN}`)
    .send(cls ? { displayName, class: cls } : { displayName });
  expect(res.status).toBe(201);
  return res.body;
}

let q = 0;
async function search(bearer: string, headers: Record<string, string> = {}, tool = 'get-web-search-summaries'): Promise<any> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}`, ...headers } },
  });
  const client = new Client({ name: 'tenancy-test', version: '0.1.0' });
  await client.connect(transport);
  try {
    return await client.callTool({ name: tool, arguments: { query: `tenancy query ${++q} ${Date.now()}`, limit: 1 } });
  } finally {
    await transport.close().catch(() => {});
  }
}
const text = (r: any): string => (r?.content || []).map((c: any) => c.text || '').join('\n');
const usage = async (days = 7) =>
  (await request(app).get(`/v1/admin/usage?days=${days}`).set('Authorization', `Bearer ${ADMIN}`)).body;

describe('tenant class', () => {
  it('admin create accepts class internal; default is public; bad class is 400; list shows class, never hashes', async () => {
    const pub = await mint('cls-public');
    const int = await mint('cls-internal', 'internal');
    expect(pub.class).toBe('public');
    expect(int.class).toBe('internal');
    const bad = await request(app).post('/v1/admin/tenants').set('Authorization', `Bearer ${ADMIN}`)
      .send({ displayName: 'x', class: 'root' });
    expect(bad.status).toBe(400);
    const list = await request(app).get('/v1/admin/tenants').set('Authorization', `Bearer ${ADMIN}`);
    const byId = Object.fromEntries(list.body.tenants.map((t: any) => [t.tenantId, t]));
    expect(byId[pub.tenantId].class).toBe('public');
    expect(byId[int.tenantId].class).toBe('internal');
    expect(JSON.stringify(list.body)).not.toMatch(/argon2|bearerHash/);
  });

  it('/v1/provision always mints public, even when asked for internal', async () => {
    process.env.PROVISION_SECRET = 'prov-secret';
    const res = await request(app).post('/v1/provision').set('X-Provision-Secret', 'prov-secret')
      .send({ label: 'demo:x', class: 'internal' });
    expect(res.status).toBe(201);
    expect(res.body.class).toBe('public');
  });
});

describe('Serper key per class', () => {
  it('public without its own key gets a clear bring-your-own-key error and never spends the env key', async () => {
    const t = await mint('pub-nokey');
    const res = await search(t.bearer);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/your own Serper/i);
    expect(keysSent).toEqual([]);
  });

  it('public with its own key spends exactly that key', async () => {
    const t = await mint('pub-byo');
    const res = await search(t.bearer, { 'X-Serper-Key': 'caller-byo-key' });
    expect(res.isError).toBeFalsy();
    expect(keysSent).toEqual(['caller-byo-key']);
  });

  it('internal uses the server key file and ignores a caller-sent key', async () => {
    writeKeyFile(0o600);
    const t = await mint('int-ok', 'internal');
    const res = await search(t.bearer, { 'X-Serper-Key': 'caller-key-ignored' });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain('Stub result');
    expect(keysSent).toEqual([INTERNAL_KEY]);
  });

  it('internal refuses a group/other-readable key file (clear error, no Serper call)', async () => {
    writeKeyFile(0o644);
    const t = await mint('int-loose', 'internal');
    const res = await search(t.bearer);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/internal Serper key is not (configured|available)/i);
    expect(keysSent).toEqual([]);
    writeKeyFile(0o600);
  });

  it('internal with no key file fails clearly, never falls back to the env key or browser search', async () => {
    rmSync(KEY_FILE, { force: true });
    const t = await mint('int-missing', 'internal');
    const res = await search(t.bearer);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/internal Serper key is not (configured|available)/i);
    expect(keysSent).toEqual([]);
    writeKeyFile(0o600);
  });
});

describe('internal keys are tailnet-only', () => {
  it('internal bearer over the public Funnel (Tailscale-Funnel-Request) is 403 and logged in refused.jsonl', async () => {
    const t = await mint('int-funnel', 'internal');
    const res = await request(app).post('/mcp').set('Authorization', `Bearer ${t.bearer}`)
      .set('Tailscale-Funnel-Request', '?1').set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(res.status).toBe(403);
    const { flushRefused } = await import('../../src/refused-log.js');
    await flushRefused();
    const lines = readFileSync(path.join(TMP, 'logs', 'refused.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.some((l) => l.status === 403 && l.path === '/mcp' && l['tailscale-funnel-request'] === '?1')).toBe(true);
  });

  it('internal bearer on loopback / tailnet serve (no Funnel header) succeeds', async () => {
    const t = await mint('int-loopback', 'internal');
    const res = await search(t.bearer);
    expect(res.isError).toBeFalsy();
    expect(keysSent).toEqual([INTERNAL_KEY]);
  });

  it('a public bearer over the Funnel is still served', async () => {
    const t = await mint('pub-funnel');
    const res = await search(t.bearer, { 'Tailscale-Funnel-Request': '?1', 'X-Serper-Key': 'funnel-byo' });
    expect(res.isError).toBeFalsy();
  });
});

describe('rate limits per class', () => {
  it('public keeps TENANT_RATE_LIMIT, internal gets INTERNAL_TENANT_RATE_LIMIT', async () => {
    process.env.TENANT_RATE_LIMIT = '2';
    process.env.INTERNAL_TENANT_RATE_LIMIT = '4';
    try {
      const pub = await mint('rl-pub');
      const int = await mint('rl-int', 'internal');
      const hit = (b: string) => request(app).post('/mcp').set('Authorization', `Bearer ${b}`)
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 }).then((r) => r.status);
      const pubStatuses = [await hit(pub.bearer), await hit(pub.bearer), await hit(pub.bearer)];
      const intStatuses = [await hit(int.bearer), await hit(int.bearer), await hit(int.bearer), await hit(int.bearer), await hit(int.bearer)];
      expect(pubStatuses).toEqual([200, 200, 429]);
      expect(intStatuses).toEqual([200, 200, 200, 200, 429]);
    } finally {
      process.env.TENANT_RATE_LIMIT = '1000';
      process.env.INTERNAL_TENANT_RATE_LIMIT = '1000';
    }
  });
});

describe('metering and /v1/admin/usage', () => {
  it('counts serper requests by keySource and calls/errors by class, persists them, and leaks no keys', async () => {
    writeKeyFile(0o600);
    const before = await usage();
    const pub = await mint('meter-pub');
    const int = await mint('meter-int', 'internal');
    await search(pub.bearer, { 'X-Serper-Key': OWN_KEY }); // the website spending our key -> own
    await search(pub.bearer, { 'X-Serper-Key': 'someone-elses-key' }); // byo
    await search(int.bearer); // internal
    await search(pub.bearer); // error: no key

    const after = await usage();
    const today = new Date().toISOString().slice(0, 10);
    const d0 = before.days.find((d: any) => d.date === today);
    const d1 = after.days.find((d: any) => d.date === today);
    expect(d1.serper.own - d0.serper.own).toBe(1);
    expect(d1.serper.byo - d0.serper.byo).toBe(1);
    expect(d1.serper.internal - d0.serper.internal).toBe(1);
    expect(d1.calls.public - d0.calls.public).toBe(3);
    expect(d1.calls.internal - d0.calls.internal).toBe(1);
    expect(d1.errors.public - d0.errors.public).toBe(1);

    const tp = after.tenants.find((t: any) => t.id === pub.tenantId);
    expect(tp).toMatchObject({ displayName: 'meter-pub', class: 'public', calls: 3, serper: 2, errors: 1 });
    const ti = after.tenants.find((t: any) => t.id === int.tenantId);
    expect(ti).toMatchObject({ class: 'internal', calls: 1, serper: 1, errors: 0 });

    for (const b of ['ownDaily', 'ownMonthly', 'internalDaily', 'internalMonthly']) {
      expect(after.budgets[b]).toEqual(expect.objectContaining({ used: expect.any(Number), limit: expect.any(Number), pct: expect.any(Number), warn: expect.any(Boolean) }));
    }
    expect(after.budgets.ownDaily.used).toBeGreaterThanOrEqual(1);
    expect(after.serperBalance).toBe(12345);

    const raw = JSON.stringify(after);
    for (const secret of [OWN_KEY, INTERNAL_KEY, ENV_KEY, 'someone-elses-key', process.env.OWN_SERPER_KEY_SHA256!, pub.bearer]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).not.toMatch(/argon2|bearerHash/);

    // persisted to <DATA_DIR>/usage/usage-YYYY-MM.json
    const { flushUsage } = await import('../../src/usage-meter.js');
    await flushUsage();
    const file = path.join(TMP, 'usage', `usage-${today.slice(0, 7)}.json`);
    expect(existsSync(file)).toBe(true);
    const disk = readFileSync(file, 'utf8');
    expect(disk).not.toContain(OWN_KEY);
    expect(JSON.parse(disk).days[today].serper.own).toBe(d1.serper.own);
  });

  it('usage is localhost-only and admin-token gated', async () => {
    expect((await request(app).get('/v1/admin/usage')).status).toBe(401);
    expect((await request(app).get('/v1/admin/usage').set('Authorization', `Bearer ${ADMIN}`)
      .set('X-Forwarded-For', '203.0.113.1')).status).toBe(403);
  });

  it('serperBalance is fetched at most once per 10 minutes', async () => {
    const n = accountCalls;
    await usage();
    await usage();
    expect(accountCalls - n).toBeLessThanOrEqual(0); // already cached by the earlier test
  });
});

describe('caps and budgets', () => {
  it('per-key monthly cap refuses with which limit, the number and when it resets', async () => {
    process.env.PUBLIC_MONTHLY_SERPER_CAP = '2';
    const t = await mint('cap-pub');
    expect((await search(t.bearer, { 'X-Serper-Key': 'cap-key' })).isError).toBeFalsy();
    expect((await search(t.bearer, { 'X-Serper-Key': 'cap-key' })).isError).toBeFalsy();
    const third = await search(t.bearer, { 'X-Serper-Key': 'cap-key' });
    expect(third.isError).toBe(true);
    expect(text(third)).toMatch(/monthly/i);
    expect(text(third)).toMatch(/\b2\b/);
    expect(text(third)).toMatch(/resets/i);
    expect(keysSent).toEqual(['cap-key', 'cap-key']);
  });

  it('the own-key daily budget refuses public callers spending our key, and warns at 80 %', async () => {
    const pre = (await usage()).budgets.ownDaily.used;
    process.env.OWN_DAILY_BUDGET = String(pre + 1);
    const t = await mint('budget-pub');
    expect((await search(t.bearer, { 'X-Serper-Key': OWN_KEY })).isError).toBeFalsy();
    const u = await usage();
    expect(u.budgets.ownDaily.warn).toBe(true);
    const res = await search(t.bearer, { 'X-Serper-Key': OWN_KEY });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/daily/i);
    expect(text(res)).toMatch(/resets/i);
    // a caller with their own key is not held by our budget
    expect((await search(t.bearer, { 'X-Serper-Key': 'their-own' })).isError).toBeFalsy();
  });

  it('the internal daily budget refuses internal keys; public budget is not touched by internal use', async () => {
    writeKeyFile(0o600);
    const pre = await usage();
    process.env.INTERNAL_DAILY_BUDGET = String(pre.budgets.internalDaily.used);
    const t = await mint('budget-int', 'internal');
    const res = await search(t.bearer);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/internal/i);
    expect(keysSent).toEqual([]);
    const post = await usage();
    expect(post.budgets.ownDaily.used).toBe(pre.budgets.ownDaily.used);
  });
});

describe('usage survives a restart', () => {
  it('a fresh meter reads the persisted month file', async () => {
    const mod = await import('../../src/usage-meter.js');
    await mod.flushUsage();
    const before = mod.usageReport(1, {}).days[0];
    mod.reloadUsageForTests();
    const after = mod.usageReport(1, {}).days[0];
    expect(after.serper).toEqual(before.serper);
    expect(after.calls).toEqual(before.calls);
  });
});

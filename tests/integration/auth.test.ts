/**
 * Tenant Bearer auth + admin route integration tests.
 *
 * Boots the express app from `buildApp()` against an isolated tenants store
 * (DATA_DIR pointed at a per-test temp dir). The shared `WebSearchMCPServer`
 * instance is constructed once and reused — its tool handlers never run in
 * these tests because we either short-circuit on auth or only test the admin
 * surface, so no external HTTP calls happen.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { Express } from 'express';

const ADMIN_TOKEN = 'test-admin-token-do-not-use-in-prod';

let tmpDir: string;
let app: Express;
let sharedInstance: { closeAll(): Promise<void> };

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-web-search-auth-'));
  process.env.DATA_DIR = tmpDir;
  process.env.MCP_WEB_SEARCH_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.TENANT_RATE_LIMIT = '5'; // tighter for the rate-limit test below

  // Imports happen AFTER env is set so module-level reads see the right values.
  const { WebSearchMCPServer } = await import('../../src/server.js');
  const { buildApp } = await import('../../src/http-server.js');
  const { invalidateTenantsCache } = await import('../../src/auth.js');

  sharedInstance = new WebSearchMCPServer({ skipShutdownHooks: true });
  app = buildApp(sharedInstance as never);
  invalidateTenantsCache();
});

beforeEach(async () => {
  // Reset tenant store between tests for deterministic state.
  const tenantsPath = path.join(tmpDir, 'tenants.json');
  try { await fs.unlink(tenantsPath); } catch { /* ok */ }
  const { invalidateTenantsCache } = await import('../../src/auth.js');
  invalidateTenantsCache();
});

afterAll(async () => {
  await sharedInstance.closeAll().catch(() => { /* best effort */ });
  try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
});

describe('healthz', () => {
  it('is unauthenticated and returns 11 tools', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, tools: 11 });
  });
});

describe('admin: tenant lifecycle', () => {
  it('rejects admin routes without admin Bearer', async () => {
    const res = await request(app)
      .post('/v1/admin/tenants')
      .send({ displayName: 'foo' });
    expect(res.status).toBe(401);
  });

  it('rejects admin routes with wrong admin Bearer', async () => {
    const res = await request(app)
      .post('/v1/admin/tenants')
      .set('Authorization', 'Bearer wrong-token')
      .send({ displayName: 'foo' });
    expect(res.status).toBe(401);
  });

  it('mints, lists, and revokes a tenant', async () => {
    const create = await request(app)
      .post('/v1/admin/tenants')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ displayName: 'cognirunner-test' });
    expect(create.status).toBe(201);
    expect(create.body.tenantId).toMatch(/^[0-9a-f-]{36}$/);
    expect(create.body.bearer).toBeTruthy();
    const tenantId = create.body.tenantId;

    const list = await request(app)
      .get('/v1/admin/tenants')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(list.status).toBe(200);
    expect(list.body.tenants).toHaveLength(1);
    expect(list.body.tenants[0]).toMatchObject({
      tenantId,
      displayName: 'cognirunner-test',
      activeHashCount: 1,
    });

    const del = await request(app)
      .delete(`/v1/admin/tenants/${tenantId}`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ revoked: tenantId });

    const listAfter = await request(app)
      .get('/v1/admin/tenants')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(listAfter.body.tenants).toHaveLength(0);
  });

  it('rotates a bearer and keeps the previous one valid during the grace window', async () => {
    const create = await request(app)
      .post('/v1/admin/tenants')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ displayName: 'rotate-test' });
    const tenantId = create.body.tenantId;
    const oldBearer = create.body.bearer;

    const rotate = await request(app)
      .post(`/v1/admin/tenants/${tenantId}/rotate`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(rotate.status).toBe(200);
    expect(rotate.body.bearer).toBeTruthy();
    expect(rotate.body.bearer).not.toBe(oldBearer);
    expect(rotate.body.oldBearerExpiresAt).toBeTruthy();

    // Both old (within grace) and new bearer should authenticate.
    const list = await request(app)
      .get('/v1/admin/tenants')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(list.body.tenants[0].activeHashCount).toBe(2);
  });

  it('returns 400 when displayName is missing', async () => {
    const res = await request(app)
      .post('/v1/admin/tenants')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('/mcp Bearer enforcement', () => {
  it('returns 401 with no Authorization header', async () => {
    const res = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(401);
  });

  it('returns 401 with malformed Authorization', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', 'NotBearer abc')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(401);
  });

  it('returns 401 with unknown bearer', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer totally-bogus-bearer')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(401);
  });

  it('rejects after revoke', async () => {
    const create = await request(app)
      .post('/v1/admin/tenants')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ displayName: 'revoke-test' });
    const { tenantId, bearer } = create.body;

    await request(app)
      .delete(`/v1/admin/tenants/${tenantId}`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(401);
  });
});

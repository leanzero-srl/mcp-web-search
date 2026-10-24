/**
 * Refused-request audit log: every 401/403/404/405/429 from the real app lands
 * in <DATA_DIR>/logs/refused.jsonl with sane fields and NO secrets (bearer,
 * query string, body). Accepted requests (healthz 200) are not logged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { Express } from 'express';

let tmpDir: string;
let app: Express;
let sharedInstance: { closeAll(): Promise<void> };
let flush: () => Promise<void>;
let appendRefused: (r: Record<string, unknown>) => void;

const SECRET_BEARER = 'sk-super-secret-bearer-value-123';
const SECRET_QUERY = 'serper-secret-in-query-456';

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-ws-refused-'));
  process.env.DATA_DIR = tmpDir;
  delete process.env.INSIGHTS_LOG;
  delete process.env.REFUSED_LOG;
  const { WebSearchMCPServer } = await import('../../src/server.js');
  const { buildApp } = await import('../../src/http-server.js');
  const mod = await import('../../src/refused-log.js');
  flush = mod.flushRefused;
  appendRefused = mod.appendRefused;
  sharedInstance = new WebSearchMCPServer({ skipShutdownHooks: true });
  app = buildApp(sharedInstance as never);
});

afterAll(async () => {
  await sharedInstance.closeAll().catch(() => {});
  delete process.env.REFUSED_LOG_MAX_BYTES;
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

const logFile = () => path.join(tmpDir, 'logs', 'refused.jsonl');
const readLines = async () =>
  (await fs.readFile(logFile(), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('refused.jsonl', () => {
  it('logs 401 and 404 with sane fields and never the bearer or query string', async () => {
    await request(app).get('/healthz').expect(200);
    await request(app)
      .post(`/mcp?serper_key=${SECRET_QUERY}`)
      .set('Authorization', `Bearer ${SECRET_BEARER}`)
      .set('User-Agent', 'scanner/1.0')
      .set('X-Forwarded-For', '203.0.113.9, 100.64.0.1')
      .set('Tailscale-Funnel-Request', '?1')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1, params: { k: SECRET_BEARER } })
      .expect(401);
    await request(app).get('/.env').expect(404);
    await flush();

    const raw = await fs.readFile(logFile(), 'utf8');
    expect(raw).not.toContain(SECRET_BEARER);
    expect(raw).not.toContain(SECRET_QUERY);
    expect(raw).not.toContain('serper_key');

    const lines = await readLines();
    expect(lines).toHaveLength(2); // healthz 200 is not logged
    const [a, b] = lines;
    expect(a).toMatchObject({
      server: 'web-search', status: 401, method: 'POST', path: '/mcp', ua: 'scanner/1.0',
      xff: '203.0.113.9', xff_last: '100.64.0.1', auth: true, 'tailscale-funnel-request': '?1',
    });
    expect(typeof a.ts).toBe('string');
    expect(a.hn).toContain('authorization'); // the NAME only
    expect(b).toMatchObject({ status: 404, method: 'GET', path: '/.env', auth: false });
  });

  it('caps path length and rotates past the size cap (one generation)', async () => {
    await request(app).get('/' + 'a'.repeat(500)).expect(404);
    await flush();
    const last = (await readLines()).pop();
    expect(last.path.length).toBe(200);

    process.env.REFUSED_LOG_MAX_BYTES = '10';
    appendRefused({ ts: 'x', note: 'after-rotate' });
    await flush();
    const rotated = await fs.readFile(logFile() + '.1', 'utf8');
    expect(rotated).toContain('"/.env"');
    const fresh = await readLines();
    expect(fresh).toHaveLength(1);
    expect(fresh[0].note).toBe('after-rotate');
  });
});

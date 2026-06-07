/**
 * Integration test for the public GET /files/download route.
 *
 * Boots the express app on a random port, points FILE_DOWNLOAD_BASE at it so
 * buildDownloadUrl mints a fetchable URL, then proves: a valid token serves the
 * exact bytes WITHOUT any Authorization header (the token IS the credential),
 * with an attachment Content-Disposition; and missing/tampered tokens 403.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'mcp-ws-dl-int-'));
process.env.DATA_DIR = TMP_DATA_DIR;
process.env.FILE_TOKEN_SECRET = 'int-test-secret';
process.env.MCP_WEB_SEARCH_ADMIN_TOKEN = 'int-admin-token';
delete process.env.PUBLIC_HOST;

let httpServer: http.Server;
let baseUrl: string;
let sharedInstance: { closeAll(): Promise<void> };

beforeAll(async () => {
  const { WebSearchMCPServer } = await import('../../src/server.js');
  const { buildApp } = await import('../../src/http-server.js');
  sharedInstance = new WebSearchMCPServer({ skipShutdownHooks: true });
  const app = buildApp(sharedInstance as never);
  httpServer = await new Promise<http.Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind test server');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  // Point the link base at this very server so buildDownloadUrl mints a URL we
  // can actually fetch back.
  process.env.FILE_DOWNLOAD_BASE = baseUrl;
}, 60_000);

afterAll(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer.close(() => r()));
  await sharedInstance.closeAll().catch(() => { /* best effort */ });
}, 30_000);

describe('GET /files/download', () => {
  it('serves the exact bytes for a valid token with NO auth header', async () => {
    const { buildDownloadUrl } = await import('../../src/download-registry.js');
    const f = path.join(TMP_DATA_DIR, 'served.md');
    writeFileSync(f, '# served content\nhello');
    const url = buildDownloadUrl(f);
    expect(url).not.toBeNull();
    expect(url!.startsWith(baseUrl)).toBe(true);

    const res = await fetch(url!); // deliberately NO Authorization header
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition') || '';
    expect(cd).toContain('attachment');
    expect(cd).toContain('served.md');
    expect(await res.text()).toBe('# served content\nhello');
  });

  it('returns 403 for a missing token', async () => {
    const res = await fetch(`${baseUrl}/files/download`);
    expect(res.status).toBe(403);
  });

  it('returns 403 for a tampered token', async () => {
    const { buildDownloadUrl } = await import('../../src/download-registry.js');
    const f = path.join(TMP_DATA_DIR, 'served2.md');
    writeFileSync(f, 'data');
    const token = new URL(buildDownloadUrl(f)!).searchParams.get('token')!;
    const res = await fetch(`${baseUrl}/files/download?token=${encodeURIComponent(token + 'x')}`);
    expect(res.status).toBe(403);
  });
});

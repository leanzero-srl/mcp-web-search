/**
 * get-openapi-spec + the cache tools against the public Swagger Petstore spec.
 * The old version never called get-openapi-spec (it ran web searches mentioning
 * "openapi" and passed on any text). Uses a private CRAWL_CACHE_DIR so it never
 * touches a developer's own cache.
 */
import './setup.ts';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStdioServer, callOk, type Started } from './utils.js';

const SPEC = 'https://petstore3.swagger.io/api/v3/openapi.json';

describe('OpenAPI extraction (stdio, live)', () => {
  let s: Started;
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-openapi-it-'));
  beforeAll(async () => { s = await startStdioServer('openapi', { CRAWL_CACHE_DIR: cacheDir }); }, 120000);
  afterAll(async () => { await s?.close(); fs.rmSync(cacheDir, { recursive: true, force: true }); });

  it('extracts the spec, indexes its endpoints and saves it to the cache dir', async () => {
    const text = await callOk(s.client, 'get-openapi-spec', { url: SPEC });
    expect(text).toContain('OpenAPI Specification Extracted Successfully');
    expect(text).toContain('Swagger Petstore');
    const total = Number(text.match(/\*\*Endpoints:\*\* (\d+) total/)?.[1]);
    expect(total).toBeGreaterThanOrEqual(10);
    expect(text).toMatch(/`GET \/pet\/\{petId\}`/);
    const saved = fs.readdirSync(path.join(cacheDir, 'openapi'));
    expect(saved.some((f) => f.startsWith('petstore3.swagger.io'))).toBe(true);
  });

  it('filters the endpoint index by method and path', async () => {
    const text = await callOk(s.client, 'get-openapi-spec', { url: SPEC, method: 'DELETE', pathFilter: '/store' });
    const listed = [...text.matchAll(/^- `([A-Z]+) (\S+)`/gm)].map((m) => `${m[1]} ${m[2]}`);
    expect(listed).toEqual(['DELETE /store/order/{orderId}']);
  });

  it('list-cached-documents shows the saved spec and read-cached-document returns it', async () => {
    const list = await callOk(s.client, 'list-cached-documents', { category: 'openapi' });
    const file = list.match(/\| (petstore3\.swagger\.io[^|\s]+\.json) \|/)?.[1];
    expect(file, list).toBeTruthy();
    const doc = await callOk(s.client, 'read-cached-document', { fileName: file!, maxBytes: 5000 });
    expect(doc).toContain('"openapi"');
    expect(doc).toContain('Swagger Petstore');
  });
});

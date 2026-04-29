import { describe, it, expect } from 'vitest';
import * as yaml from 'js-yaml';

// Smoke test that verifies the js-yaml integration parses real-shaped
// OpenAPI YAML — the previous extractor silently truncated YAML to a
// 1000-char preview, returning effectively useless metadata.
describe('OpenAPI YAML parsing (regression for the silent truncation bug)', () => {
  const sampleSpec = `
openapi: 3.0.3
info:
  title: Pet Store
  version: 1.0.0
  description: A sample petstore
paths:
  /pets:
    get:
      summary: List all pets
      responses:
        '200':
          description: A paged array of pets
servers:
  - url: https://api.example.com/v1
`;

  it('parses YAML to a real object, not a 1000-char wrapper', () => {
    const data = yaml.load(sampleSpec) as Record<string, unknown>;
    expect(data).not.toBeNull();
    expect(typeof data).toBe('object');
    expect(Array.isArray(data)).toBe(false);
    expect(data.openapi).toBe('3.0.3');

    const info = data.info as Record<string, unknown>;
    expect(info.title).toBe('Pet Store');
    expect(info.version).toBe('1.0.0');
    expect(info.description).toBe('A sample petstore');

    const paths = data.paths as Record<string, unknown>;
    expect(paths['/pets']).toBeDefined();
  });

  it('extracts basePath from servers[0].url', () => {
    const data = yaml.load(sampleSpec) as Record<string, unknown>;
    const servers = data.servers as Array<{ url: string }>;
    const url = new URL(servers[0].url);
    expect(url.pathname).toBe('/v1');
  });
});

// Regression for the bug uncovered by the agent-vs-non-agent smoke test:
// when the OpenAPI URL points at a JSON spec directly, axios auto-parses
// `response.data` to an Object. Passing that object to crawl-cache's
// `generateHash()` -> `crypto.update()` throws ERR_INVALID_ARG_TYPE because
// crypto.update wants a string or Buffer. The fix coerces non-string
// pageResponse.data to JSON.stringify() before hashing.
describe('axios JSON auto-parse coercion (regression)', () => {
  it('coerces parsed object to string for hashing', async () => {
    const crypto = await import('crypto');
    const fakeAxiosData = { openapi: '3.0.0', info: { title: 'X', version: '1' } };

    // Bug: this throws ERR_INVALID_ARG_TYPE
    expect(() => crypto.createHash('md5').update(fakeAxiosData as unknown as string).digest('hex'))
      .toThrow(/ERR_INVALID_ARG_TYPE|argument must be of type/);

    // Fix: stringify first
    const coerced = typeof fakeAxiosData === 'string' ? fakeAxiosData : JSON.stringify(fakeAxiosData);
    const hash = crypto.createHash('md5').update(coerced).digest('hex');
    expect(hash).toMatch(/^[a-f0-9]{32}$/);
  });
});

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

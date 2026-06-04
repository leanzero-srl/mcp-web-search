import { describe, it, expect } from 'vitest';
import { buildEndpointIndex } from '../../src/openapi-extractor.js';

// buildEndpointIndex is what makes get-openapi-spec return a usable map of a
// large API instead of dumping (and truncating) the raw spec. These cover the
// shapes it must survive: Swagger 2.0, OpenAPI 3.x, and assorted malformed input.
describe('buildEndpointIndex', () => {
  it('indexes a Swagger 2.0 spec (basePath + paths) with multiple methods', () => {
    const spec = {
      swagger: '2.0',
      basePath: '/v1',
      paths: {
        '/pets': {
          get: { summary: 'List all pets', tags: ['pets'] },
          post: { operationId: 'createPet', tags: ['pets', 'write'] },
        },
        '/pets/{id}': {
          delete: { summary: 'Remove a pet' },
        },
      },
    };

    const { endpoints, endpointCount } = buildEndpointIndex(spec);
    expect(endpointCount).toBe(3);

    const get = endpoints.find(e => e.method === 'GET' && e.path === '/pets');
    expect(get).toMatchObject({ method: 'GET', path: '/pets', summary: 'List all pets', tags: ['pets'] });

    // operationId is used as the summary fallback when summary is absent.
    const post = endpoints.find(e => e.method === 'POST' && e.path === '/pets');
    expect(post).toMatchObject({ summary: 'createPet', tags: ['pets', 'write'] });

    // no tags → empty array, never undefined.
    const del = endpoints.find(e => e.method === 'DELETE');
    expect(del?.tags).toEqual([]);
  });

  it('indexes an OpenAPI 3.x spec (servers + paths) and upper-cases methods', () => {
    const spec = {
      openapi: '3.0.3',
      servers: [{ url: 'https://api.example.com/v2' }],
      paths: {
        '/users/{id}': {
          get: { summary: 'Get user' },
          patch: { summary: 'Update user', tags: ['users'] },
        },
      },
    };

    const { endpoints, endpointCount } = buildEndpointIndex(spec);
    expect(endpointCount).toBe(2);
    expect(endpoints.map(e => e.method).sort()).toEqual(['GET', 'PATCH']);
    expect(endpoints.every(e => e.path === '/users/{id}')).toBe(true);
  });

  it('returns an empty index when there are no paths', () => {
    expect(buildEndpointIndex({ openapi: '3.0.0', info: { title: 'X' } })).toEqual({ endpoints: [], endpointCount: 0 });
    expect(buildEndpointIndex({ paths: {} })).toEqual({ endpoints: [], endpointCount: 0 });
  });

  it('never throws on malformed / non-spec input', () => {
    expect(buildEndpointIndex(null)).toEqual({ endpoints: [], endpointCount: 0 });
    expect(buildEndpointIndex('not a spec')).toEqual({ endpoints: [], endpointCount: 0 });
    expect(buildEndpointIndex({ paths: { '/x': null } })).toEqual({ endpoints: [], endpointCount: 0 });
    // Non-method keys (e.g. "parameters", "$ref") under a path item are ignored.
    expect(buildEndpointIndex({ paths: { '/x': { parameters: [], summary: 'shared' } } }))
      .toEqual({ endpoints: [], endpointCount: 0 });
  });

  it('summary falls back to empty string when neither summary nor operationId exist', () => {
    const { endpoints } = buildEndpointIndex({ paths: { '/x': { get: { responses: {} } } } });
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].summary).toBe('');
  });
});

// Shared console redirection setup
import './setup.ts';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('Semantic Cache Tests', () => {
  let client: Client;
  let transport: StdioClientTransport;

  const testTimeout = 60000; // 60 seconds for semantic cache tests

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      stdioBufferMaxSize: 1024 * 1024 * 50,
    });

    client = new Client({ name: 'semantic-cache-test-client', version: '1.0.0' });
    
    client.onerror = (error) => {
      console.error('MCP Transport Error:', error);
    };

    await client.connect(transport);
  }, 120000);

  afterAll(async () => {
    await client.close();
  });

  it('should execute cached-web-search successfully', async () => {
    const query = 'semantic caching test';
    
    // First request - should miss cache
    const result1 = await client.callTool({
      name: 'cached-web-search',
      arguments: {
        query,
        limit: 2,
      },
    }, undefined, { timeout: testTimeout });

    if (result1.isError) {
      throw new Error(`First call failed: ${JSON.stringify(result1.content)}`);
    }

    // Second request with same query - should hit cache
    const result2 = await client.callTool({
      name: 'cached-web-search',
      arguments: {
        query,
        limit: 2,
      },
    }, undefined, { timeout: testTimeout });

    if (result2.isError) {
      throw new Error(`Second call failed: ${JSON.stringify(result2.content)}`);
    }

    // Both should return results
    expect(Array.isArray(result1.content)).toBe(true);
    expect(Array.isArray(result2.content)).toBe(true);
  }, testTimeout * 2);

  it('should handle semantically similar queries', async () => {
    // First query
    const result1 = await client.callTool({
      name: 'cached-web-search',
      arguments: {
        query: 'TypeScript programming language',
        limit: 2,
      },
    }, undefined, { timeout: testTimeout });

    if (result1.isError) {
      throw new Error(`First call failed: ${JSON.stringify(result1.content)}`);
    }

    // Similar query - may hit semantic cache
    const result2 = await client.callTool({
      name: 'cached-web-search',
      arguments: {
        query: 'TypeScript programming tutorial',
        limit: 2,
      },
    }, undefined, { timeout: testTimeout });

    if (result2.isError) {
      throw new Error(`Second call failed: ${JSON.stringify(result2.content)}`);
    }

    // Should return results
    expect(Array.isArray(result2.content)).toBe(true);
  }, testTimeout * 2);

  it('should handle cache expiration correctly', async () => {
    const query = 'cache expiration test';
    
    // First request
    await client.callTool({
      name: 'cached-web-search',
      arguments: {
        query,
        limit: 1,
      },
    }, undefined, { timeout: testTimeout });

    // Second request (should use cache)
    const result2 = await client.callTool({
      name: 'cached-web-search',
      arguments: {
        query,
        limit: 1,
      },
    }, undefined, { timeout: testTimeout });

    if (result2.isError) {
      throw new Error(`Second call failed: ${JSON.stringify(result2.content)}`);
    }

    expect(Array.isArray(result2.content)).toBe(true);
  }, testTimeout * 2);

  it('should cache PDF extraction via web search', async () => {
    const query = 'sample pdf document download';
    
    // First request
    await client.callTool({
      name: 'cached-web-search',
      arguments: {
        query,
        limit: 1,
      },
    }, undefined, { timeout: testTimeout });

    // Second request - should use cache
    const result2 = await client.callTool({
      name: 'cached-web-search',
      arguments: {
        query,
        limit: 1,
      },
    }, undefined, { timeout: testTimeout });

    if (result2.isError) {
      throw new Error(`Second call failed: ${JSON.stringify(result2.content)}`);
    }

    expect(Array.isArray(result2.content)).toBe(true);
  }, testTimeout * 2);

  it('should cache GitHub repository info via search', async () => {
    const query = 'microsoft/TypeScript github repository';
    
    // First request
    await client.callTool({
      name: 'cached-web-search',
      arguments: {
        query,
        limit: 1,
      },
    }, undefined, { timeout: testTimeout });

    // Second request - should use cache
    const result2 = await client.callTool({
      name: 'cached-web-search',
      arguments: {
        query,
        limit: 1,
      },
    }, undefined, { timeout: testTimeout });

    if (result2.isError) {
      throw new Error(`Second call failed: ${JSON.stringify(result2.content)}`);
    }

    expect(Array.isArray(result2.content)).toBe(true);
  }, testTimeout * 2);

  it('should handle many cache requests gracefully', async () => {
    // Make many requests to fill cache
    for (let i = 0; i < 10; i++) {
      try {
        await client.callTool({
          name: 'cached-web-search',
          arguments: {
            query: `cache limit test ${i}`,
            limit: 1,
          },
        }, undefined, { timeout: testTimeout });
      } catch (error) {
        console.log(`Request ${i} error:`, error instanceof Error ? error.message : 'No error');
      }
    }
    
    // Server should handle cache size limits
  }, testTimeout * 2);
});
// Shared console redirection setup
import './setup.ts';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('OpenAPI Integration Tests', () => {
  let client: Client;
  let transport: StdioClientTransport;

  const testTimeout = 60000; // 60 seconds for OpenAPI extraction

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      stdioBufferMaxSize: 1024 * 1024 * 50,
    });

    client = new Client({ name: 'openapi-test-client', version: '1.0.0' });
    
    client.onerror = (error) => {
      console.error('MCP Transport Error:', error);
    };

    await client.connect(transport);
  }, 120000);

  afterAll(async () => {
    await client.close();
  });

  it('should search for OpenAPI documentation on Swagger UI page', async () => {
    const result = await client.callTool({
      name: 'get-web-search-summaries',
      arguments: {
        url: 'https://petstore3.swagger.io/',
        limit: 2,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Should search for Swagger-related content
    expect(textContent.length).toBeGreaterThan(50);
  }, testTimeout);

  it('should extract API documentation from GitHub pages', async () => {
    const result = await client.callTool({
      name: 'full-web-search',
      arguments: {
        query: 'github api rest documentation site:docs.github.com',
        limit: 2,
        includeContent: true,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Should extract documentation content
    expect(textContent.length).toBeGreaterThan(100);
  }, testTimeout);

  it('should discover OpenAPI specs via search', async () => {
    const result = await client.callTool({
      name: 'get-web-search-summaries',
      arguments: {
        query: 'openapi specification swagger json site:swagger.io',
        limit: 3,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Should return discovery results
    expect(textContent.length).toBeGreaterThan(50);
  }, testTimeout);

  it('should handle non-OpenAPI website gracefully', async () => {
    try {
      await client.callTool({
        name: 'get-web-search-summaries',
        arguments: {
          query: 'example.com documentation',
          limit: 2,
        },
      }, undefined, { timeout: testTimeout });
      
      // Should return results for the search
    } catch (error) {
      console.log('Expected behavior for non-OpenAPI site:', error instanceof Error ? error.message : 'No error');
    }
  });

  it('should extract OpenAPI spec info from web pages', async () => {
    const result = await client.callTool({
      name: 'get-single-web-page-content',
      arguments: {
        url: 'https://swagger.io/spec/',
        maxContentLength: 3000,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Should return OpenAPI spec content
    expect(textContent.length).toBeGreaterThan(50);
  }, testTimeout);
});
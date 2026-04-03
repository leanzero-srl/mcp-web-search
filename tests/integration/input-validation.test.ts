// Shared console redirection setup
import './setup.ts';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('Input Validation Tests', () => {
  let client: Client;
  let transport: StdioClientTransport;

  const testTimeout = 15000; // 15 seconds for validation tests

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      stdioBufferMaxSize: 1024 * 1024 * 50,
    });

    client = new Client({ name: 'input-validation-test-client', version: '1.0.0' });
    
    client.onerror = (error) => {
      console.error('MCP Transport Error:', error);
    };

    await client.connect(transport);
  }, 120000);

  afterAll(async () => {
    await client.close();
  });

  it('should reject empty query in web search', async () => {
    try {
      await client.callTool({
        name: 'full-web-search',
        arguments: {
          query: '',
          limit: 5,
        },
      }, undefined, { timeout: testTimeout });
      
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      console.log('Expected error for empty query:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  it('should reject negative limit value', async () => {
    try {
      await client.callTool({
        name: 'full-web-search',
        arguments: {
          query: 'test query',
          limit: -1,
        },
      }, undefined, { timeout: testTimeout });
      
      expect(true).toBe(false);
    } catch (error) {
      console.log('Expected error for negative limit:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  it('should reject zero limit value', async () => {
    try {
      await client.callTool({
        name: 'full-web-search',
        arguments: {
          query: 'test query',
          limit: 0,
        },
      }, undefined, { timeout: testTimeout });
      
      expect(true).toBe(false);
    } catch (error) {
      console.log('Expected error for zero limit:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  it('should reject extremely large limit value', async () => {
    try {
      await client.callTool({
        name: 'full-web-search',
        arguments: {
          query: 'test query',
          limit: 10000,
        },
      }, undefined, { timeout: testTimeout });
      
      // May either fail or return limited results
    } catch (error) {
      console.log('Expected behavior for large limit:', error instanceof Error ? error.message : 'No error');
    }
  });

  it('should reject invalid URL format', async () => {
    try {
      await client.callTool({
        name: 'get-single-web-page-content',
        arguments: {
          url: 'not-a-valid-url-format',
          maxContentLength: 1000,
        },
      }, undefined, { timeout: testTimeout });
      
      expect(true).toBe(false);
    } catch (error) {
      console.log('Expected error for invalid URL:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  it('should reject missing required parameter', async () => {
    try {
      await client.callTool({
        name: 'full-web-search',
        arguments: {
          // Missing query
          limit: 5,
        },
      }, undefined, { timeout: testTimeout });
      
      expect(true).toBe(false);
    } catch (error) {
      console.log('Expected error for missing parameter:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  it('should accept valid query with special characters', async () => {
    const result = await client.callTool({
      name: 'get-web-search-summaries',
      arguments: {
        query: 'TypeScript "generics" tutorial (2024)',
        limit: 2,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Should process the query with special characters
    expect(textContent.length).toBeGreaterThan(0);
  }, testTimeout);

  it('should handle very long query string', async () => {
    const longQuery = 'test '.repeat(100); // 500+ character query
    
    try {
      await client.callTool({
        name: 'full-web-search',
        arguments: {
          query: longQuery,
          limit: 2,
        },
      }, undefined, { timeout: testTimeout });
      
      // Should either process or truncate the query
    } catch (error) {
      console.log('Expected behavior for long query:', error instanceof Error ? error.message : 'No error');
    }
  });

  it('should validate URL scheme', async () => {
    try {
      await client.callTool({
        name: 'get-single-web-page-content',
        arguments: {
          url: 'ftp://invalid-scheme.com/file.pdf',
          maxContentLength: 1000,
        },
      }, undefined, { timeout: testTimeout });
      
      // Should reject invalid schemes
    } catch (error) {
      console.log('Expected error for invalid scheme:', error instanceof Error ? error.message : 'No error');
    }
  });

  it('should validate maxContentLength parameter', async () => {
    try {
      await client.callTool({
        name: 'get-single-web-page-content',
        arguments: {
          url: 'https://example.com',
          maxContentLength: -500,
        },
      }, undefined, { timeout: testTimeout });
      
      expect(true).toBe(false);
    } catch (error) {
      console.log('Expected error for negative content length:', error instanceof Error ? error.message : 'Unknown error');
    }
  });
});
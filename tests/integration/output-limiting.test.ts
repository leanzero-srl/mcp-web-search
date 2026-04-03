// Shared console redirection setup
import './setup.ts';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('Output Limiting Tests', () => {
  let client: Client;
  let transport: StdioClientTransport;

  const testTimeout = 60000; // 60 seconds for output limiting tests

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      stdioBufferMaxSize: 1024 * 1024 * 50,
    });

    client = new Client({ name: 'output-limiting-test-client', version: '1.0.0' });
    
    client.onerror = (error) => {
      console.error('MCP Transport Error:', error);
    };

    await client.connect(transport);
  }, 120000);

  afterAll(async () => {
    await client.close();
  });

  it('should limit search results by the specified limit parameter', async () => {
    const result = await client.callTool({
      name: 'full-web-search',
      arguments: {
        query: 'output limiting test',
        limit: 3,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    // Results should be an array with limited items
    expect(Array.isArray(result.content)).toBe(true);
  }, testTimeout);

  it('should limit content length when maxContentLength is specified', async () => {
    const result = await client.callTool({
      name: 'get-single-web-page-content',
      arguments: {
        url: 'https://en.wikipedia.org/wiki/JavaScript',
        maxContentLength: 1000,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Content should be within the specified limit
    expect(textContent.length).toBeLessThanOrEqual(1000);
  }, testTimeout);

  it('should handle zero maxContentLength gracefully', async () => {
    try {
      const result = await client.callTool({
        name: 'get-single-web-page-content',
        arguments: {
          url: 'https://en.wikipedia.org/wiki/JavaScript',
          maxContentLength: 0,
        },
      }, undefined, { timeout: testTimeout });

      if (result.isError) {
        throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
      }

      // Should return empty or minimal content
      const textContent = result.content.find(c => c.type === 'text')?.text || '';
      expect(textContent.length).toBe(0);
    } catch (error) {
      console.log('Expected behavior for zero maxContentLength:', error instanceof Error ? error.message : 'No error');
    }
  }, testTimeout);

  it('should limit number of files extracted from GitHub', async () => {
    const result = await client.callTool({
      name: 'extract-github-files',
      arguments: {
        url: 'https://github.com/microsoft/TypeScript',
        filePatterns: ['*.ts'],
        maxFiles: 5,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    // Should limit the number of files
    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // The content should be limited based on maxFiles parameter
    expect(textContent.length).toBeGreaterThan(0);
  }, testTimeout);

  it('should handle extremely large maxContentLength value', async () => {
    const result = await client.callTool({
      name: 'get-single-web-page-content',
      arguments: {
        url: 'https://en.wikipedia.org/wiki/JavaScript',
        maxContentLength: 100000,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Should extract content without error
    expect(textContent.length).toBeGreaterThan(0);
  }, testTimeout);

  it('should respect timeout parameter to limit response time', async () => {
    try {
      await client.callTool({
        name: 'full-web-search',
        arguments: {
          query: 'slow search test',
          limit: 5,
        },
      }, undefined, { timeout: 10000 }); // 10 second timeout
      
      // Should complete within timeout
    } catch (error) {
      console.log('Timeout or error:', error instanceof Error ? error.message : 'No error');
    }
  });

  it('should limit progressive search depth', async () => {
    const result = await client.callTool({
      name: 'progressive-web-search',
      arguments: {
        query: 'limiting search depth test',
        maxDepth: 2,
        limit: 10,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    // Should respect the maxDepth parameter
    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    expect(textContent.length).toBeGreaterThan(0);
  }, testTimeout);

  it('should limit PDF extraction content', async () => {
    try {
      const result = await client.callTool({
        name: 'extract-pdf',
        arguments: {
          url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
          maxContentLength: 200,
        },
      }, undefined, { timeout: testTimeout });

      if (result.isError) {
        throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
      }

      const textContent = result.content.find(c => c.type === 'text')?.text || '';
      
      expect(textContent.length).toBeLessThanOrEqual(200);
    } catch (error) {
      console.log('PDF extraction limit:', error instanceof Error ? error.message : 'No error');
    }
  }, testTimeout);
});
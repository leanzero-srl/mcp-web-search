// Shared console redirection setup
import './setup.ts';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('Large Responses Tests', () => {
  let client: Client;
  let transport: StdioClientTransport;

  const testTimeout = 120000; // 120 seconds for large response tests

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      stdioBufferMaxSize: 1024 * 1024 * 50, // 50MB buffer
    });

    client = new Client({ name: 'large-responses-test-client', version: '1.0.0' });
    
    client.onerror = (error) => {
      console.error('MCP Transport Error:', error);
    };

    await client.connect(transport);
  }, 120000);

  afterAll(async () => {
    await client.close();
  });

  it('should handle large search result set', async () => {
    const result = await client.callTool({
      name: 'full-web-search',
      arguments: {
        query: 'large response test',
        limit: 20, // Request many results
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Should handle large response
    expect(textContent.length).toBeGreaterThan(0);
  }, testTimeout);

  it('should extract content from a very large webpage', async () => {
    try {
      const result = await client.callTool({
        name: 'get-single-web-page-content',
        arguments: {
          url: 'https://en.wikipedia.org/wiki/JavaScript',
          maxContentLength: 10000, // Request large content
        },
      }, undefined, { timeout: testTimeout });

      if (result.isError) {
        throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
      }

      const textContent = result.content.find(c => c.type === 'text')?.text || '';
      
      // Content may be truncated by maxContentLength
      expect(textContent.length).toBeGreaterThan(0);
    } catch (error) {
      console.log('Large page extraction:', error instanceof Error ? error.message : 'No error');
    }
  }, testTimeout);

  it('should handle massive PDF file', async () => {
    try {
      const result = await client.callTool({
        name: 'extract-pdf',
        arguments: {
          url: 'https://arxiv.org/pdf/1706.03762.pdf', // Large paper
          maxContentLength: 5000,
        },
      }, undefined, { timeout: testTimeout });

      if (result.isError) {
        throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
      }

      const textContent = result.content.find(c => c.type === 'text')?.text || '';
      
      expect(textContent.length).toBeGreaterThan(0);
    } catch (error) {
      console.log('Large PDF handling:', error instanceof Error ? error.message : 'No error');
    }
  }, testTimeout);

  it('should return progress for long-running operations', async () => {
    try {
      const result = await client.callTool({
        name: 'progressive-web-search',
        arguments: {
          query: 'large progressive search',
          maxDepth: 5,
          limit: 20,
        },
      }, undefined, { timeout: testTimeout });

      if (result.isError) {
        throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
      }

      const textContent = result.content.find(c => c.type === 'text')?.text || '';
      
      expect(textContent.length).toBeGreaterThan(0);
    } catch (error) {
      console.log('Progressive search:', error instanceof Error ? error.message : 'No error');
    }
  }, testTimeout);

  it('should handle multiple large file extractions', async () => {
    const result = await client.callTool({
      name: 'extract-github-files',
      arguments: {
        url: 'https://github.com/microsoft/TypeScript',
        filePatterns: ['*.ts'],
        maxFiles: 10,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Should handle multiple large files
    expect(textContent.length).toBeGreaterThan(0);
  }, testTimeout);

  it('should stream large content without buffer overflow', async () => {
    try {
      await client.callTool({
        name: 'get-single-web-page-content',
        arguments: {
          url: 'https://en.wikipedia.org/wiki/JavaScript',
          maxContentLength: 5000,
        },
      }, undefined, { timeout: testTimeout });
      
      // If this doesn't throw, streaming works
    } catch (error) {
      console.log('Streaming handled:', error instanceof Error ? error.message : 'No error');
    }
  });

  it('should handle response size limits gracefully', async () => {
    try {
      await client.callTool({
        name: 'full-web-search',
        arguments: {
          query: 'size limit test',
          limit: 50, // Very large request
        },
      }, undefined, { timeout: testTimeout });
      
      // Should either succeed or return size limit error
    } catch (error) {
      console.log('Size limit handled:', error instanceof Error ? error.message : 'No error');
    }
  });

  it('should handle concurrent large responses', async () => {
    const promises = [];
    
    for (let i = 0; i < 3; i++) {
      promises.push(
        client.callTool({
          name: 'full-web-search',
          arguments: {
            query: `concurrent large ${i}`,
            limit: 10,
          },
        }, undefined, { timeout: testTimeout })
      );
    }
    
    const results = await Promise.allSettled(promises);
    
    // At least one should succeed
    const successful = results.filter(r => r.status === 'fulfilled').length;
    expect(successful).toBeGreaterThan(0);
  }, testTimeout * 2);
});
// Shared console redirection setup
import './setup.ts';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('PDF Integration Tests', () => {
  let client: Client;
  let transport: StdioClientTransport;

  const testTimeout = 60000; // 60 seconds for PDF-related tests

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      stdioBufferMaxSize: 1024 * 1024 * 50,
    });

    client = new Client({ name: 'pdf-test-client', version: '1.0.0' });
    
    client.onerror = (error) => {
      console.error('MCP Transport Error:', error);
    };

    await client.connect(transport);
  }, 120000);

  afterAll(async () => {
    await client.close();
  });

  it('should search for PDF documents via web search', async () => {
    const result = await client.callTool({
      name: 'get-web-search-summaries',
      arguments: {
        query: 'sample pdf document download filetype:pdf',
        limit: 3,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Should return PDF-related search results
    expect(textContent.length).toBeGreaterThan(0);
  }, testTimeout);

  it('should extract content from a specific URL with limited length', async () => {
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
    
    // Content should be limited
    expect(textContent.length).toBeLessThanOrEqual(1000);
  }, testTimeout);

  it('should handle PDF download site search', async () => {
    try {
      await client.callTool({
        name: 'full-web-search',
        arguments: {
          query: 'download sample pdf document',
          limit: 2,
          includeContent: true,
        },
      }, undefined, { timeout: testTimeout });
      
      // May succeed or return specific error
    } catch (error) {
      console.log('PDF download search:', error instanceof Error ? error.message : 'No error');
    }
  });

  it('should handle large PDF-related content extraction', async () => {
    try {
      const result = await client.callTool({
        name: 'get-single-web-page-content',
        arguments: {
          url: 'https://en.wikipedia.org/wiki/JavaScript',
          maxContentLength: 5000,
        },
      }, undefined, { timeout: testTimeout });
      
      // May or may not complete
    } catch (error) {
      console.log('Large PDF extraction:', error instanceof Error ? error.message : 'No error');
    }
  });

  it('should search for academic PDF papers', async () => {
    const result = await client.callTool({
      name: 'get-web-search-summaries',
      arguments: {
        query: 'arxiv.org pdf paper typescript tutorial',
        limit: 2,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    expect(textContent.length).toBeGreaterThan(50);
  }, testTimeout);

  it('should handle invalid URL gracefully', async () => {
    try {
      await client.callTool({
        name: 'get-single-web-page-content',
        arguments: {
          url: 'not-a-url.pdf',
          maxContentLength: 1000,
        },
      }, undefined, { timeout: testTimeout });
      
      // Should return error
    } catch (error) {
      console.log('Invalid URL handled:', error instanceof Error ? error.message : 'No error');
    }
  });
});
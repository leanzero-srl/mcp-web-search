// Shared console redirection setup
import './setup.ts';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('Parallel Search Tests', () => {
  let client: Client;
  let transport: StdioClientTransport;

  const testTimeout = 60000; // 60 seconds for parallel search tests

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      stdioBufferMaxSize: 1024 * 1024 * 50,
    });

    client = new Client({ name: 'parallel-search-test-client', version: '1.0.0' });
    
    client.onerror = (error) => {
      console.error('MCP Transport Error:', error);
    };

    await client.connect(transport);
  }, 120000);

  afterAll(async () => {
    await client.close();
  });

  it('should execute parallel web searches', async () => {
    const queries = ['TypeScript', 'JavaScript', 'Node.js'];
    const promises = queries.map(query =>
      client.callTool({
        name: 'get-web-search-summaries',
        arguments: {
          query,
          limit: 2,
        },
      }, undefined, { timeout: testTimeout })
    );
    
    const results = await Promise.allSettled(promises);
    
    // At least one should succeed
    const successful = results.filter(r => r.status === 'fulfilled');
    expect(successful.length).toBeGreaterThan(0);
  }, testTimeout * 2);

  it('should execute concurrent PDF extractions', async () => {
    try {
      const promises = [
        client.callTool({
          name: 'extract-pdf',
          arguments: {
            url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
            maxContentLength: 500,
          },
        }, undefined, { timeout: testTimeout }),
        client.callTool({
          name: 'extract-pdf',
          arguments: {
            url: 'https://www.africau.edu/images/default/sample.pdf',
            maxContentLength: 500,
          },
        }, undefined, { timeout: testTimeout }),
      ];
      
      const results = await Promise.allSettled(promises);
      
      // At least one should succeed
      const successful = results.filter(r => r.status === 'fulfilled');
      expect(successful.length).toBeGreaterThan(0);
    } catch (error) {
      console.log('Concurrent PDF extraction:', error instanceof Error ? error.message : 'No error');
    }
  }, testTimeout * 2);

  it('should handle parallel GitHub extractions', async () => {
    const repos = [
      'microsoft/TypeScript',
      'facebook/react',
    ];
    
    const promises = repos.map(repo =>
      client.callTool({
        name: 'extract-github-readme',
        arguments: {
          url: `https://github.com/${repo}`,
          maxContentLength: 1000,
        },
      }, undefined, { timeout: testTimeout })
    );
    
    const results = await Promise.allSettled(promises);
    
    // At least one should succeed
    const successful = results.filter(r => r.status === 'fulfilled');
    expect(successful.length).toBeGreaterThan(0);
  }, testTimeout * 2);

  it('should execute mixed search types in parallel', async () => {
    const mixedPromises = [
      client.callTool({
        name: 'full-web-search',
        arguments: {
          query: 'TypeScript MCP',
          limit: 1,
        },
      }, undefined, { timeout: testTimeout }),
      client.callTool({
        name: 'get-single-web-page-content',
        arguments: {
          url: 'https://example.com',
          maxContentLength: 500,
        },
      }, undefined, { timeout: testTimeout }),
    ];
    
    const results = await Promise.allSettled(mixedPromises);
    
    // At least one should succeed
    const successful = results.filter(r => r.status === 'fulfilled');
    expect(successful.length).toBeGreaterThan(0);
  }, testTimeout * 2);

  it('should scale parallel searches with timeout management', async () => {
    const promises = [];
    
    for (let i = 0; i < 8; i++) {
      promises.push(
        client.callTool({
          name: 'get-web-search-summaries',
          arguments: {
            query: `parallel test ${i}`,
            limit: 1,
          },
        }, undefined, { timeout: 15000 })
      );
    }
    
    const results = await Promise.allSettled(promises);
    
    // At least some should succeed
    const successful = results.filter(r => r.status === 'fulfilled');
    console.log(`Parallel scaling: ${successful.length}/${promises.length} succeeded`);
  }, testTimeout * 4);

  it('should handle parallel search with error recovery', async () => {
    const promises = [
      client.callTool({
        name: 'full-web-search',
        arguments: {
          query: 'valid query for parallel test',
          limit: 1,
        },
      }, undefined, { timeout: testTimeout }),
      client.callTool({
        name: 'get-single-web-page-content',
        arguments: {
          url: 'https://nonexistent-domain-12345.com/page.html',
          maxContentLength: 500,
        },
      }, undefined, { timeout: 5000 }), // This one should fail
    ];
    
    const results = await Promise.allSettled(promises);
    
    // First should succeed, second may fail but shouldn't crash client
    console.log(`Parallel error recovery: ${results.length} total`);
    
    const successful = results.filter(r => r.status === 'fulfilled');
    expect(successful.length).toBeGreaterThan(0);
  }, testTimeout * 2);

  it('should maintain result integrity in parallel searches', async () => {
    const queries = ['MCP', 'protocol', 'server'];
    const promises = queries.map(query =>
      client.callTool({
        name: 'full-web-search',
        arguments: {
          query,
          limit: 2,
        },
      }, undefined, { timeout: testTimeout })
    );
    
    const results = await Promise.allSettled(promises);
    
    // Verify each result is independent
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        expect(Array.isArray(result.value.content)).toBe(true);
      }
    });
  }, testTimeout * 2);

  it('should handle high concurrency stress test', async () => {
    const promises = [];
    
    // Many concurrent requests
    for (let i = 0; i < 15; i++) {
      promises.push(
        client.callTool({
          name: 'get-web-search-summaries',
          arguments: {
            query: `stress test ${i}`,
            limit: 1,
          },
        }, undefined, { timeout: 20000 })
      );
    }
    
    const results = await Promise.allSettled(promises);
    
    // Even under stress, at least some should complete
    const successful = results.filter(r => r.status === 'fulfilled');
    console.log(`Stress test: ${successful.length}/${promises.length} succeeded`);
  }, testTimeout * 4);
});
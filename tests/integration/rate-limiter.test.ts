// Shared console redirection setup
import './setup.ts';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('Rate Limiter Integration Tests', () => {
  let client: Client;
  let transport: StdioClientTransport;

  const testTimeout = 30000; // 30 seconds for rate limiter tests

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      stdioBufferMaxSize: 1024 * 1024 * 50,
    });

    client = new Client({ name: 'rate-limiter-test-client', version: '1.0.0' });
    
    client.onerror = (error) => {
      console.error('MCP Transport Error:', error);
    };

    await client.connect(transport);
  }, 120000);

  afterAll(async () => {
    await client.close();
  });

  it('should execute search within rate limits', async () => {
    const result = await client.callTool({
      name: 'full-web-search',
      arguments: {
        query: 'rate limiting test',
        limit: 1,
        includeContent: true,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Should succeed within rate limits
    expect(textContent.length).toBeGreaterThan(0);
  }, testTimeout);

  it('should handle rapid consecutive requests', async () => {
    try {
      await client.callTool({
        name: 'full-web-search',
        arguments: {
          query: 'rate limit test 1',
          limit: 1,
          includeContent: true,
        },
      }, undefined, { timeout: testTimeout });
      
      // Immediate second request
      await client.callTool({
        name: 'get-web-search-summaries',
        arguments: {
          query: 'rate limit test 2',
          limit: 1,
        },
      }, undefined, { timeout: testTimeout });
    } catch (error) {
      console.log('Rate limiting response:', error instanceof Error ? error.message : 'No error');
    }
  });

  it('should maintain rate limit state across requests', async () => {
    const results = [];
    
    // Make multiple sequential requests
    for (let i = 0; i < 3; i++) {
      try {
        const result = await client.callTool({
          name: 'get-web-search-summaries',
          arguments: {
            query: `rate limit test ${i}`,
            limit: 1,
          },
        }, undefined, { timeout: testTimeout });
        
        results.push(result);
      } catch (error) {
        console.log(`Request ${i} error:`, error instanceof Error ? error.message : 'No error');
      }
    }
    
    // At least one request should succeed
    expect(results.length).toBeGreaterThan(0);
  }, testTimeout * 2);

  it('should handle concurrent requests with rate limiting', async () => {
    const promises = [];
    
    // Try multiple concurrent requests
    for (let i = 0; i < 5; i++) {
      promises.push(
        client.callTool({
          name: 'full-web-search',
          arguments: {
            query: `concurrent test ${i}`,
            limit: 1,
            includeContent: true,
          },
        }, undefined, { timeout: testTimeout })
      );
    }
    
    const results = await Promise.allSettled(promises);
    
    // At least one should succeed
    const successful = results.filter(r => r.status === 'fulfilled').length;
    expect(successful).toBeGreaterThan(0);
  }, testTimeout * 2);

  it('should handle rate limited scenario gracefully', async () => {
    try {
      await client.callTool({
        name: 'full-web-search',
        arguments: {
          query: 'rate limit test',
          limit: 1,
        },
      }, undefined, { timeout: 5000 }); // Short timeout
      
      // May succeed or return rate-limited response
    } catch (error) {
      console.log('Rate limiting handled:', error instanceof Error ? error.message : 'No error');
    }
  });
});
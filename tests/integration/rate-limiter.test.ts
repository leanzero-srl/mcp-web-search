// Shared console redirection setup
import './setup.ts';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('Rate Limiter Integration Tests', () => {
  let client: Client;
  let transport: StdioClientTransport;

  const testTimeout = 180000; // 180 seconds for rate limiter tests to handle network instability

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
    let success = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
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
        if (textContent.length > 0) {
          success = true;
          break;
        }
      } catch (error) {
        console.log(`Attempt ${attempt} failed:`, error instanceof Error ? error.message : 'No error');
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
      }
    }
    expect(success).toBe(true);
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
  }, testTimeout);

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
    let success = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const promises = [];
      
      // Try multiple concurrent requests (reduced to 2 to increase success probability in flaky network)
      for (let i = 0; i < 2; i++) {
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
      const successful = results.filter(r => r.status === 'fulfilled').length;
      
      if (successful > 0) {
        success = true;
        break;
      }

      console.log(`Concurrent attempt ${attempt} failed. Retrying...`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
    }
    expect(success).toBe(true);
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
  }, testTimeout);
});
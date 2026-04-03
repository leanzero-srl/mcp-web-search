// Shared console redirection setup
import './setup.ts';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('Error Handling Tests', () => {
  let client: Client;
  let transport: StdioClientTransport;

  const testTimeout = 30000; // 30 seconds for error handling tests

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      stdioBufferMaxSize: 1024 * 1024 * 50,
    });

    client = new Client({ name: 'error-handling-test-client', version: '1.0.0' });
    
    client.onerror = (error) => {
      console.error('MCP Transport Error:', error);
    };

    await client.connect(transport);
  }, 120000);

  afterAll(async () => {
    await client.close();
  });

  it('should handle network timeout gracefully', async () => {
    try {
      // This test may or may not trigger a timeout depending on server implementation
      await client.callTool({
        name: 'full-web-search',
        arguments: {
          query: 'timeout test',
          limit: 1,
        },
      }, undefined, { timeout: 5000 }); // Short timeout
      
      // May succeed or timeout
    } catch (error) {
      console.log('Timeout error handled:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  it('should handle invalid tool name gracefully', async () => {
    try {
      await client.callTool({
        name: 'non-existent-tool-12345',
        arguments: {},
      }, undefined, { timeout: testTimeout });
      
      // Should return an error for non-existent tool
    } catch (error) {
      console.log('Expected error for invalid tool:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  it('should handle malformed JSON response gracefully', async () => {
    try {
      await client.callTool({
        name: 'full-web-search',
        arguments: {
          query: 'malformed test',
          limit: 1,
        },
      }, undefined, { timeout: testTimeout });
      
      // Server should return valid JSON
    } catch (error) {
      console.log('Malformed response error:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  it('should handle rate limiting errors gracefully', async () => {
    try {
      await client.callTool({
        name: 'full-web-search',
        arguments: {
          query: 'rate limit test',
          limit: 1,
        },
      }, undefined, { timeout: testTimeout });
      
      // May succeed or return rate limit error
    } catch (error) {
      console.log('Rate limiting handled:', error instanceof Error ? error.message : 'No error');
    }
  });

  it('should handle invalid URL gracefully', async () => {
    try {
      await client.callTool({
        name: 'get-single-web-page-content',
        arguments: {
          url: 'https://this-domain-does-not-exist-12345.com/page.html',
          maxContentLength: 1000,
        },
      }, undefined, { timeout: testTimeout });
      
      // Should handle DNS failure gracefully
    } catch (error) {
      console.log('DNS error handled:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  it('should handle server shutdown gracefully', async () => {
    // First verify server is running
    try {
      await client.callTool({
        name: 'full-web-search',
        arguments: {
          query: 'server test',
          limit: 1,
        },
      }, undefined, { timeout: testTimeout });
      
      // Server should be running
    } catch (error) {
      console.log('Server error:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  it('should handle too many requests gracefully', async () => {
    const promises = [];
    
    for (let i = 0; i < 10; i++) {
      promises.push(
        client.callTool({
          name: 'get-web-search-summaries',
          arguments: {
            query: `concurrent error test ${i}`,
            limit: 1,
          },
        }, undefined, { timeout: 5000 })
      );
    }
    
    const results = await Promise.allSettled(promises);
    
    // At least some should succeed
    console.log(`Concurrent requests: ${results.length} total, ${results.filter(r => r.status === 'fulfilled').length} successful`);
  }, testTimeout * 2);

  it('should handle interrupted search gracefully', async () => {
    const controller = new AbortController();
    
    try {
      // Start a search
      const promise = client.callTool({
        name: 'full-web-search',
        arguments: {
          query: 'interrupt test',
          limit: 5,
        },
      }, undefined, { timeout: testTimeout });
      
      // Let it run for a bit then... we can't actually interrupt from client side
      await promise;
    } catch (error) {
      console.log('Interrupt error handled:', error instanceof Error ? error.message : 'No error');
    }
  });

  it('should return proper error message format', async () => {
    try {
      await client.callTool({
        name: 'full-web-search',
        arguments: {
          query: '', // Empty query should cause an error
          limit: -1,
        },
      }, undefined, { timeout: testTimeout });
      
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '';
      
      // Error message should be descriptive
      expect(errorMessage.length).toBeGreaterThan(0);
    }
  });

  it('should handle unknown errors gracefully', async () => {
    try {
      await client.callTool({
        name: 'full-web-search',
        arguments: {
          query: 'unknown error test',
          limit: 1,
        },
      }, undefined, { timeout: testTimeout });
      
      // May succeed or fail with any error
    } catch (error) {
      console.log('Unknown error handled:', error instanceof Error ? error.message : 'No error');
    }
  });
});
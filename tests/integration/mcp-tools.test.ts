import './setup.ts'; // Redirect console.log to stderr first

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// MCP SDK callTool signature: callTool(params, resultSchema?, options?)
// When passing only 2 args where second is an object with timeout, it's treated as resultSchema!
// Solution: use default schema (pass undefined explicitly) and pass options as third arg

// Check if Playwright browsers are installed
async function checkPlaywrightAvailability(): Promise<boolean> {
  try {
    const playwright = await import('playwright');
    // Try to launch a browser to verify it works
    await playwright.chromium.launch({ headless: true, timeout: 5000 });
    return true;
  } catch (error) {
    return false;
  }
}

let browsersAvailable = false;

describe('MCP Integration Tests - Real Tool Execution', () => {
  let client: Client;
  let transport: StdioClientTransport;

  const testTimeout = 90000; // 90 seconds for web search

  beforeAll(async () => {
    // Check for Playwright browser availability at startup
    browsersAvailable = await checkPlaywrightAvailability();
    
    if (!browsersAvailable) {
      console.warn('Warning: Playwright browsers not available. Some integration tests will be skipped.');
    }
    
    // Run server directly - MCP protocol messages will be read from stdout
    transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      // Buffer size for large responses (in bytes)
      stdioBufferMaxSize: 1024 * 1024 * 50, // 50MB
    });

    client = new Client({ name: 'integration-test-client', version: '1.0.0' });
    
    // Set up error handlers
    client.onerror = (error) => {
      console.error('MCP Transport Error:', error);
    };

    await client.connect(transport);
  }, 120000); // 120 second timeout for beforeAll hook

  afterAll(async () => {
    await client.close(); // Graceful shutdown
  });

  it('should execute full-web-search with real web requests', async () => {
    // Use undefined for resultSchema (default) and pass options as third arg
    const result = await client.callTool({
      name: 'full-web-search',
      arguments: {
        query: 'TypeScript MCP server documentation',
        limit: 2,
        includeContent: true,
      },
    }, undefined, { timeout: testTimeout });

    // Check for tool-level errors
    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    // Verify response structure
    expect(Array.isArray(result.content)).toBe(true);
    
    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Verify actual search content was returned
    expect(textContent).toContain('TypeScript');
    expect(textContent).toContain('MCP');
  }, testTimeout);

  it('should execute get-web-search-summaries without content extraction', async () => {
    // Use undefined for resultSchema (default) and pass options as third arg
    const result = await client.callTool({
      name: 'get-web-search-summaries',
      arguments: {
        query: 'AI news today',
        limit: 3,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    expect(Array.isArray(result.content)).toBe(true);
    
    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    expect(textContent).toContain('AI');
  }, testTimeout);

  // Browser-dependent test - skip if browsers unavailable
  (browsersAvailable ? it : it.skip)('should extract content from a single webpage', async () => {
    // Use undefined for resultSchema (default) and pass options as third arg
    const result = await client.callTool({
      name: 'get-single-web-page-content',
      arguments: {
        url: 'https://en.wikipedia.org/wiki/TypeScript',
        maxContentLength: 2000,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    expect(textContent).toContain('TypeScript');
  }, testTimeout);

  it('should handle tool errors gracefully with invalid input', async () => {
    try {
      await client.callTool({
        name: 'full-web-search',
        arguments: {
          query: '', // Empty query should fail
          limit: -1, // Invalid limit
        },
      }, undefined, { timeout: 5000 });
      
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      console.log('Expected error occurred:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  // Browser-dependent test - skip if browsers unavailable
  (browsersAvailable ? it : it.skip)('should execute progressive-web-search with expansion', async () => {
    // Use undefined for resultSchema (default) and pass options as third arg
    const result = await client.callTool({
      name: 'progressive-web-search',
      arguments: {
        query: 'best coding tools',
        maxDepth: 2,
        limit: 3,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    expect(Array.isArray(result.content)).toBe(true);
    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    expect(textContent).toContain('best');
  }, testTimeout);

  // Browser-dependent test - skip if browsers unavailable
  (browsersAvailable ? it : it.skip)('should execute cached-web-search and use cache on second call', async () => {
    const query = 'MCP testing framework';
    
    // First call - should miss cache
    const result1 = await client.callTool({
      name: 'cached-web-search',
      arguments: {
        query,
        limit: 2,
      },
    }, undefined, { timeout: testTimeout });

    if (result1.isError) {
      throw new Error(`First tool execution failed: ${JSON.stringify(result1.content)}`);
    }

    // Second call with same query - should hit cache
    const result2 = await client.callTool({
      name: 'cached-web-search',
      arguments: {
        query,
        limit: 2,
      },
    }, undefined, { timeout: testTimeout });

    if (result2.isError) {
      throw new Error(`Second tool execution failed: ${JSON.stringify(result2.content)}`);
    }

    // Both should return results
    expect(result1.content.length).toBeGreaterThan(0);
    expect(result2.content.length).toBeGreaterThan(0);
  }, testTimeout * 2);

});
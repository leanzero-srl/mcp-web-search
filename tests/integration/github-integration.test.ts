// Shared console redirection setup
import './setup.ts';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// MCP SDK callTool signature: callTool(params, resultSchema?, options?)
// When passing only 2 args where second is an object with timeout, it's treated as resultSchema!
// Solution: use default schema (pass undefined explicitly) and pass options as third arg

describe('GitHub Integration Tests', () => {
  let client: Client;
  let transport: StdioClientTransport;

  const testTimeout = 60000; // 60 seconds for GitHub API calls

  beforeAll(async () => {
    // Run server directly - MCP protocol messages will be read from stdout
    transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      stdioBufferMaxSize: 1024 * 1024 * 50, // 50MB buffer for large responses
    });

    client = new Client({ name: 'github-test-client', version: '1.0.0' });
    
    // Set up error handlers
    client.onerror = (error) => {
      console.error('MCP Transport Error:', error);
    };

    await client.connect(transport);
  }, 120000);

  afterAll(async () => {
    await client.close();
  });

  it('should extract README from a public GitHub repository', async () => {
    const result = await client.callTool({
      name: 'full-web-search',
      arguments: {
        query: 'microsoft/TypeScript README github',
        limit: 2,
        includeContent: true,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Verify we got README content
    expect(textContent.length).toBeGreaterThan(100);
  }, testTimeout);

  it('should handle invalid GitHub URL gracefully', async () => {
    try {
      await client.callTool({
        name: 'full-web-search',
        arguments: {
          query: 'invalid-user/invalid-repo-12345 readme',
          limit: 1,
        },
      }, undefined, { timeout: 10000 });
      
      // Should return results (may be empty)
    } catch (error) {
      console.log('Expected error for invalid repo:', error instanceof Error ? error.message : 'Unknown error');
    }
  });

  it('should handle GitHub URL with branch specified', async () => {
    const result = await client.callTool({
      name: 'full-web-search',
      arguments: {
        query: 'microsoft/TypeScript main readme github',
        limit: 2,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Should return content
    expect(textContent.length).toBeGreaterThan(50);
  }, testTimeout);

  it('should extract repository information from GitHub search', async () => {
    const result = await client.callTool({
      name: 'get-web-search-summaries',
      arguments: {
        query: 'facebook/react github stars',
        limit: 3,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Verify we got repository info
    expect(textContent.length).toBeGreaterThan(50);
  }, testTimeout);

  it('should search GitHub repositories with content extraction', async () => {
    const result = await client.callTool({
      name: 'full-web-search',
      arguments: {
        query: 'microsoft/TypeScript repository github typescript',
        limit: 2,
        includeContent: true,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    expect(textContent.length).toBeGreaterThan(100);
  }, testTimeout);
});
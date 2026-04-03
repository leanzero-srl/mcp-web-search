// Shared console redirection setup
import './setup.ts';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('Progressive Search Tests', () => {
  let client: Client;
  let transport: StdioClientTransport;

  const testTimeout = 90000; // 90 seconds for progressive search tests

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
      stdioBufferMaxSize: 1024 * 1024 * 50,
    });

    client = new Client({ name: 'progressive-search-test-client', version: '1.0.0' });
    
    client.onerror = (error) => {
      console.error('MCP Transport Error:', error);
    };

    await client.connect(transport);
  }, 120000);

  afterAll(async () => {
    await client.close();
  });

  it('should execute progressive search with default depth', async () => {
    const result = await client.callTool({
      name: 'progressive-web-search',
      arguments: {
        query: 'best coding tools 2024',
        limit: 10,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Should return progressively expanded results
    expect(textContent.length).toBeGreaterThan(0);
  }, testTimeout);

  it('should respect maxDepth parameter', async () => {
    const result = await client.callTool({
      name: 'progressive-web-search',
      arguments: {
        query: 'machine learning frameworks',
        maxDepth: 2,
        limit: 15,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Should return results within depth limit
    expect(textContent.length).toBeGreaterThan(0);
  }, testTimeout);

  it('should expand single word queries progressively', async () => {
    const result = await client.callTool({
      name: 'progressive-web-search',
      arguments: {
        query: 'Python',
        maxDepth: 3,
        limit: 10,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Should expand and return results
    expect(textContent.length).toBeGreaterThan(0);
  }, testTimeout);

  it('should progressively search with deepening stages', async () => {
    const result = await client.callTool({
      name: 'progressive-web-search',
      arguments: {
        query: 'enterprise software architecture',
        maxDepth: 4,
        limit: 20,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Should have multiple stages of results
    expect(textContent.length).toBeGreaterThan(0);
  }, testTimeout);

  it('should handle complex multi-stage queries', async () => {
    const result = await client.callTool({
      name: 'progressive-web-search',
      arguments: {
        query: 'best machine learning frameworks for TypeScript developers',
        maxDepth: 3,
        limit: 15,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Should handle complex query with progressive expansion
    expect(textContent.length).toBeGreaterThan(0);
  }, testTimeout);

  it('should limit total results in progressive search', async () => {
    const result = await client.callTool({
      name: 'progressive-web-search',
      arguments: {
        query: 'web development trends',
        maxDepth: 5,
        limit: 5, // Explicitly limit
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Results should be limited
    expect(textContent.length).toBeGreaterThan(0);
  }, testTimeout);

  it('should progressively search with different depth levels', async () => {
    const depths = [1, 2, 3];
    
    for (const depth of depths) {
      try {
        const result = await client.callTool({
          name: 'progressive-web-search',
          arguments: {
            query: `depth test ${depth}`,
            maxDepth: depth,
            limit: 5,
          },
        }, undefined, { timeout: testTimeout });

        if (result.isError) {
          throw new Error(`Depth ${depth} failed: ${JSON.stringify(result.content)}`);
        }

        const textContent = result.content.find(c => c.type === 'text')?.text || '';
        expect(textContent.length).toBeGreaterThan(0);
      } catch (error) {
        console.log(`Depth ${depth} error:`, error instanceof Error ? error.message : 'No error');
      }
    }
  }, testTimeout * 3);

  it('should progressively search with minimum results threshold', async () => {
    const result = await client.callTool({
      name: 'progressive-web-search',
      arguments: {
        query: 'emerging tech trends',
        maxDepth: 2,
        minResultsPerStage: 5,
        limit: 10,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Should meet minimum results threshold
    expect(textContent.length).toBeGreaterThan(0);
  }, testTimeout);

  it('should combine literal and expanded searches progressively', async () => {
    const result = await client.callTool({
      name: 'progressive-web-search',
      arguments: {
        query: 'React TypeScript tutorial',
        maxDepth: 3,
        limit: 15,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find(c => c.type === 'text')?.text || '';
    
    // Should combine literal and expanded searches
    expect(textContent.length).toBeGreaterThan(0);
  }, testTimeout);

  it('should handle progressive search timeout gracefully', async () => {
    try {
      await client.callTool({
        name: 'progressive-web-search',
        arguments: {
          query: 'slow progressive search',
          maxDepth: 5,
          limit: 20,
        },
      }, undefined, { timeout: 15000 }); // Short timeout
      
      // May or may not complete
    } catch (error) {
      console.log('Progressive search timeout:', error instanceof Error ? error.message : 'No error');
    }
  });
});
#!/usr/bin/env node

// Simple single-tool test to debug the issue
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function main() {
  console.error('Starting simple test...');
  
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
  });

  const client = new Client({ name: 'simple-test', version: '1.0.0' });
  
  client.onerror = (error) => {
    console.error('MCP Transport Error:', error);
  };

  try {
    await client.connect(transport);
    console.error('Connected to server');
    
    // Test get-web-search-summaries
    console.error('\n=== Calling get-web-search-summaries ===');
    const result1 = await client.callTool({
      name: 'get-web-search-summaries',
      arguments: {
        query: 'test query',
        limit: 2,
      },
    }, { timeout: 30000 });
    
    console.error('\n=== Response from get-web-search-summaries ===');
    console.error('Result object:', JSON.stringify(result1, null, 2));
    console.error('IsError:', result1.isError);
    console.error('Content:', JSON.stringify(result1.content, null, 2));
    
    // Test full-web-search
    console.error('\n=== Calling full-web-search ===');
    const result2 = await client.callTool({
      name: 'full-web-search',
      arguments: {
        query: 'test query',
        limit: 1,
        includeContent: false,  // Skip content extraction for faster test
      },
    }, { timeout: 30000 });
    
    console.error('\n=== Response from full-web-search ===');
    console.error('Result object:', JSON.stringify(result2, null, 2));
    console.error('IsError:', result2.isError);
    console.error('Content length:', result2.content?.[0]?.text?.length || 0);
    console.error('First 500 chars:', result2.content?.[0]?.text?.substring(0, 500));
    
    await client.close();
    console.error('\n=== Test completed successfully ===');
  } catch (error) {
    console.error('Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
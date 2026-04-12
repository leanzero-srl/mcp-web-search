import './setup.ts'; // Redirect console.log to stderr first

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as fs from 'fs';
import * as path from 'path';

async function checkPlaywrightAvailability(): Promise<boolean> {
  try {
    const playwright = await import('playwright');
    await playwright.chromium.launch({ headless: true, timeout: 5000 });
    return true;
  } catch (error) {
    return false;
  }
}

describe('Research and Save Integration Test', () => {
  let client: Client;
  let transport: StdioClientTransport;
  let browsersAvailable = false;

  const testTimeout = 90000; // 90 seconds for web search

  beforeAll(async () => {
    browsersAvailable = await checkPlaywrightAvailability();
    if (!browsersAvailable) {
      console.warn('Warning: Playwright browsers not available. Skipping test.');
      return;
    }

    transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js'],
    });

    client = new Client({ name: 'research-test-client', version: '1.0.0' });
    await client.connect(transport);
  }, 120000); // 120 second timeout for beforeAll hook

  afterAll(async () => {
    if (client) {
      await client.close(); // Graceful shutdown
    }
  });

  it('should research a page and save it to markdown', async () => {
    if (!browsersAvailable) return;

    const testUrl = 'https://en.wikipedia.org/wiki/TypeScript';
    
    const result = await client.callTool({
      name: 'research_and_save_to_markdown',
      arguments: {
        url: testUrl,
      },
    }, undefined, { timeout: testTimeout });

    if (result.isError) {
      throw new Error(`Tool execution failed: ${JSON.stringify(result.content)}`);
    }

    // Cast content to known type to satisfy TS
    const content = result.content as Array<{ type: string; text?: string }>;
    const textContent = content.find(c => c.type === 'text')?.text || '';
    
    expect(textContent).toContain('Successfully researched and saved data from');
    expect(textContent).toContain(testUrl);
    // Check if it mentions the file path (it should)
    expect(textContent).toContain('docs/research-output/');

    // Verify file existence
    const filePathMatch = textContent.match(/`([^`]+)`/);
    if (!filePathMatch) {
      throw new Error('Could not find file path in tool response');
    }
    const filePath = filePathMatch[1];

    expect(fs.existsSync(filePath)).toBe(true);

    // Verify content of the markdown file
    const mdContent = fs.readFileSync(filePath, 'utf8');
    expect(mdContent).toContain('# Research Report:');
    expect(mdContent).toContain(testUrl);
    expect(mdContent).toContain('## 🧠 Research Digest');
    expect(mdContent).toContain('## 📝 Full Content');
  }, testTimeout);
});

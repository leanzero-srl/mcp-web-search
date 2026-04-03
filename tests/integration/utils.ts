// Shared test utilities for MCP integration tests

import { Client } from '@modelcontextprotocol/sdk/client/index.js';

// Check if Playwright browsers are installed
export async function checkPlaywrightAvailability(): Promise<boolean> {
  try {
    const playwright = await import('playwright');
    // Try to launch a browser to verify it works
    await playwright.chromium.launch({ headless: true, timeout: 5000 });
    return true;
  } catch (error) {
    return false;
  }
}

// Helper to get text content from MCP response
export function extractTextContent(content: any[]): string {
  return content.find(c => c.type === 'text')?.text || '';
}

// Helper to check if a URL is accessible
export async function checkUrlAccessibility(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(url, { 
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow'
    });
    
    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}

// Helper to skip tests when browsers are not available
export function browserIt(
  description: string,
  timeout?: number
): [string, (fn: () => Promise<void>) => void] | [undefined, undefined] {
  let browsersAvailable = false;
  
  // Check availability at test time if needed
  try {
    const playwright = require('playwright');
    browsersAvailable = true;
  } catch {}
  
  if (!browsersAvailable) {
    return [description, it.skip];
  }
  
  return [description, timeout ? withTimeout(it, timeout) : it];
}

// Helper to create tests with custom timeout
export function withTimeout(testFn: typeof it, ms: number): typeof it {
  return (description: string, fn: () => Promise<void>) => {
    testFn(description, fn, ms);
  };
}
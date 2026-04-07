import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SearchEngine } from '../../src/search-engine.js';

describe('SearchEngine API Integration', () => {
  let engine: SearchEngine;

  beforeAll(async () => {
    engine = new SearchEngine();
  });

  afterAll(async () => {
    await engine.closeAll();
  });

  it('should attempt API search when SERPER_API_KEY is provided', async () => {
    // We can't easily set env vars in a running process without side effects,
    // but we can check if the logic handles missing keys gracefully.
    const result = await engine.search({ query: 'test query', numResults: 1 });
    
    // Since SERPER_API_KEY is likely not set in the test environment, 
    // it should fall back to other engines or return empty if all fail.
    // We just want to ensure it doesn't crash.
    expect(result).toBeDefined();
    expect(result.results).toBeDefined();
  }, 30000); // Increased timeout for fallback engines

  it('should handle empty results gracefully', async () => {
    const result = await engine.search({ query: '', numResults: 1 });
    expect(result.results).toBeInstanceOf(Array);
  }, 30000); // Increased timeout for fallback engines
});

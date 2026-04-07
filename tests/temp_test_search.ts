import { SearchEngine } from '../src/search-engine.js';

async function runTest() {
  console.log('--- Starting Search Test ---');
  const engine = new SearchEngine();
  
  const queries = [
    'apple',
    'microsoft',
    'open ai'
  ];

  for (const query of queries) {
    console.log(`\nTesting query: "${query}"`);
    try {
      const startTime = Date.now();
      const result = await engine.search({ query, numResults: 3 });
      const duration = Date.now() - startTime;

      console.log(`Result Engine: ${result.engine}`);
      console.log(`Results Found: ${result.results.length}`);
      console.log(`Time Taken: ${duration}ms`);

      if (result.results.length > 0) {
        console.log('First Result:');
        console.log(`  Title: ${result.results[0].title}`);
        console.log(`  URL: ${result.results[0].url}`);
      } else {
        console.log('No results found.');
      }
    } catch (error) {
      console.error(`Search failed for "${query}":`, error);
    }
  }

  await engine.closeAll();
  console.log('\n--- Test Completed ---');
}

runTest().catch(err => {
  console.error('Test script failed:', err);
  process.exit(1);
});
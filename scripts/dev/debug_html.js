import { chromium } from 'playwright';

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const urls = [
    'https://search.brave.com/search?q=test+query&source=web',
    'https://www.bing.com/search?q=test+query'
  ];

  for (const url of urls) {
    console.log(`\n--- URL: ${url} ---`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const html = await page.content();
      console.log(`HTML Length: ${html.length}`);
      // Print first 5000 chars of body to see structure
      const bodySnippet = await page.evaluate(() => document.body.innerHTML.substring(0, 5000));
      console.log('Body Snippet (first 5000 chars):');
      console.log(bodySnippet);
    } catch (err) {
      console.error(`Failed to fetch ${url}: ${err.message}`);
    }
  }

  await browser.close();
}

run().catch(err => console.error(err));
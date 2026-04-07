import { chromium } from 'playwright';

async function debugBrave() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  
  const query = 'React TypeScript tutorial';
  const searchUrl = `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`;
  
  console.log(`Navigating to: ${searchUrl}`);
  
  try {
    console.log('Waiting for network to be idle...');
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });
    
    console.log('Waiting for 5 seconds to ensure hydration...');
    await page.waitForTimeout(5000);

    const html = await page.content();
    console.log(`HTML length: ${html.length}`);

    // Inspecting tags
    const tagsToInspect = ['article', 'div', 'section', 'h2', 'h3', 'a', 'p'];
    for (const tag of tagsToInspect) {
      const count = await page.locator(tag).count();
      console.log(`Count of <${tag}>: ${count}`);
    }

    // Print first 1000 chars of HTML to see what it looks like
    console.log('--- HTML PREVIEW (first 1000 chars) ---');
    console.log(html.substring(0, 1000));
    console.log('---------------------------------------');

    // Check links
    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a')).map(a => ({
        href: a.href,
        text: a.innerText.trim()
      })).slice(0, 20);
    });
    console.log('First 20 links:');
    console.table(links);

  } catch (err) {
    console.error('Error during debugging:', err);
  } finally {
    await browser.close();
  }
}

debugBrave();
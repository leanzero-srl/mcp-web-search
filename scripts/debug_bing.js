import { chromium } from 'playwright';

async function debugBing(query) {
  console.log(`Debugging Bing for query: ${query}`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  
  try {
    console.log('Navigating to bing.com first...');
    await page.goto('https://www.bing.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1000);

    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=5&form=QBLH`;
    console.log(`Navigating to search URL: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000); // Wait for hydration
    
    const title = await page.title();
    console.log(`Page Title: "${title}"`);

    const html = await page.content();
    console.log(`HTML Length: ${html.length}`);
    
    // Print a small snippet of the body to see what's actually there
    const bodySnippet = await page.evaluate(() => document.body.innerText.substring(0, 500));
    console.log(`Body Snippet:\n${bodySnippet}`);
    
    // Find some potential result containers
    const containers = await page.evaluate(() => {
      const results = [];
      // Common Bing result containers/classes
      const selectors = ['.b_algo', '.b_result', '.b_card', '.b_results', '.b_result_container', 'div[class*="b_algo"]', 'div[class*="b_result"]'];
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          results.push({
            tagName: el.tagName,
            className: el.className,
            innerHTML: el.innerHTML.substring(0, 200)
          });
        });
      });
      return results;
    });
    
    console.log('Detected containers:', containers);
    
    // Also look for any H2/H3 with links, as these are common for results
    const links = await page.evaluate(() => {
      const links = [];
      document.querySelectorAll('h2 a, h3 a').forEach(el => {
        links.push({
          text: el.innerText,
          href: el.href,
          parentTagName: el.parentElement.tagName,
          parentClassName: el.parentElement.className
        });
      });
      return links;
    });
    
    console.log('Found links in headers:', links);
    
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await browser.close();
  }
}

debugBing(process.argv[2] || 'test query');
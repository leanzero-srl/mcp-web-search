import { describe, it, expect } from 'vitest';
import { extractVisibleText } from '../../src/enhanced-content-extractor.js';

// The browser extraction path used cheerio's `.text()` on the content area,
// which also returns the CSS/JS inside <style>/<script>. Live example.com
// (which injects a <style> into <body>) came back as
// "svg{display:block;margin:-2.75em auto 0;...}This domain is for use ...".
describe('extractVisibleText', () => {
  const page = `<!doctype html><html><head><title>T</title><style>html{color:red}</style></head>
    <body><style>svg{display:block;margin:-2.75em auto 0}</style>
    <main><p>Visible paragraph.</p><script>window.x = 1;</script><noscript>enable js</noscript>
    <template><p>not rendered</p></template><svg><text>icon</text></svg><p>Second.</p></main>
    <footer>Footer text</footer></body></html>`;

  it('drops style, script, noscript, template and svg text', () => {
    const text = extractVisibleText(page, 'body');
    expect(text).toContain('Visible paragraph.');
    expect(text).toContain('Second.');
    for (const leaked of ['svg{display', 'window.x', 'enable js', 'not rendered', 'icon', 'html{color']) {
      expect(text).not.toContain(leaked);
    }
  });

  it('uses the selector when it matches', () => {
    const text = extractVisibleText(page, 'main');
    expect(text).toContain('Visible paragraph.');
    expect(text).not.toContain('Footer text');
  });

  it('falls back to <body> when the selector matches nothing (was: empty string / "#body")', () => {
    const text = extractVisibleText(page, 'article.does-not-exist');
    expect(text).toContain('Visible paragraph.');
    expect(text).toContain('Footer text');
  });
});

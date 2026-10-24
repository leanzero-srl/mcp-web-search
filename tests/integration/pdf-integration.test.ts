/**
 * get-pdf-content against real PDFs. The old version never called the PDF tool
 * (it fetched a Wikipedia HTML page and searched for "pdf").
 */
import './setup.ts';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStdioServer, callOk, callTool, type Started } from './utils.js';

const DUMMY = 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf';
const TRACEMONKEY = 'https://raw.githubusercontent.com/mozilla/pdf.js/master/web/compressed.tracemonkey-pldi-09.pdf';

describe('PDF extraction (stdio, live)', () => {
  let s: Started;
  beforeAll(async () => { s = await startStdioServer('pdf'); }, 120000);
  afterAll(async () => { await s?.close(); });

  it('extracts a one-page PDF and reports its real byte size (was always "0 bytes")', async () => {
    const text = await callOk(s.client, 'get-pdf-content', { url: DUMMY });
    expect(text).toContain('Dummy PDF file');
    expect(text).toContain('**Pages:** 1');
    const reported = Number(text.match(/\*\*File Size:\*\* (\d+) bytes/)?.[1]);
    const actual = (await (await fetch(DUMMY)).arrayBuffer()).byteLength;
    expect(reported).toBe(actual);
  });

  it('extracts a multi-page paper and honours maxContentLength on the content', async () => {
    const text = await callOk(s.client, 'get-pdf-content', { url: TRACEMONKEY, maxContentLength: 300 });
    expect(text).toContain('**Pages:** 14');
    expect(text).toContain('Trace-based Just-in-Time Type Specialization');
    const preview = text.split('**Content Preview:**\n')[1] ?? '';
    expect(preview.replace(/\n*\[Content truncated[^\]]*\]\s*$/, '').length).toBeLessThanOrEqual(300);
    expect(text).toContain('[Content truncated');
  });

  it('two PDFs extracted in parallel each return their own text', async () => {
    const [a, b] = await Promise.all([
      callOk(s.client, 'get-pdf-content', { url: DUMMY, maxContentLength: 500 }),
      callOk(s.client, 'get-pdf-content', { url: TRACEMONKEY, maxContentLength: 500 }),
    ]);
    expect(a).toContain('Dummy PDF file');
    expect(a).not.toContain('Trace-based');
    expect(b).toContain('Trace-based');
  });

  it('a PDF URL that 404s is a "not found" tool error, not the site\'s HTML error page', async () => {
    const r = await callTool(s.client, 'get-pdf-content', { url: 'https://www.w3.org/this-file-does-not-exist-xyz.pdf' }, 60000);
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toMatch(/404|not found/i);
    expect(r.text).not.toContain('**Content Preview:**');
  });
});

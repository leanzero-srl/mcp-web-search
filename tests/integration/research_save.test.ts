/**
 * research_and_save_to_markdown writes a real report. Runs with a private
 * OUTPUT_DIR so it never drops files into the checkout. The old version
 * returned early (and passed) whenever a Chromium launch failed — the tool
 * does not even need a browser for this page.
 */
import './setup.ts';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStdioServer, callOk, type Started } from './utils.js';

describe('Research and save (stdio, live)', () => {
  let s: Started;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-research-it-'));
  beforeAll(async () => { s = await startStdioServer('research-save', { OUTPUT_DIR: outDir }); }, 120000);
  afterAll(async () => { await s?.close(); fs.rmSync(outDir, { recursive: true, force: true }); });

  it('researches a page and saves a markdown report with digest and full content', async () => {
    const url = 'https://en.wikipedia.org/wiki/TypeScript';
    const text = await callOk(s.client, 'research_and_save_to_markdown', { url }, 120000);
    expect(text).toContain('Research complete!');
    expect(text).toContain(url);
    const filePath = text.match(/`([^`]+\.md)`/)?.[1];
    expect(filePath, text).toBeTruthy();
    const abs = path.isAbsolute(filePath!) ? filePath! : path.resolve(outDir, filePath!);
    expect(abs.startsWith(fs.realpathSync(outDir)) || abs.startsWith(outDir), `report written outside OUTPUT_DIR: ${abs}`).toBe(true);
    const md = fs.readFileSync(abs, 'utf8');
    expect(md).toContain('# Research Report:');
    expect(md).toContain(url);
    expect(md).toContain('## 🧠 Research Digest');
    expect(md).toContain('## 📝 Full Content');
    expect(md).toContain('Microsoft');
    expect(md.length).toBeGreaterThan(5000);
  }, 130000);
});

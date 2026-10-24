/**
 * stdio transport hygiene: EVERY line the stdio server writes to stdout must be
 * a JSON-RPC frame. Before the stdio-shim fix, the module-level singletons
 * (BrowserPool, SemanticCache, RequestDeduplicator, CrawlCache) printed four
 * plain-text lines at import time, because the shim call in index.ts ran after
 * the hoisted `import './server.js'`. Every stdio client then logged a
 * "MCP Transport Error" per line (hundreds in this suite). Hermetic: no network.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';

function runAndCollectStdout(entry: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [entry], { stdio: ['pipe', 'pipe', 'ignore'], env: process.env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdout-hygiene', version: '1' } } });
    const timer = setInterval(() => {
      if (out.includes('"id":1')) {
        clearInterval(timer);
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      }
    }, 100);
    const done = setInterval(() => {
      if (out.includes('"id":2')) {
        clearInterval(done);
        child.kill();
        resolve(out.split('\n').filter((l) => l.trim() !== ''));
      }
    }, 100);
    setTimeout(() => { clearInterval(timer); clearInterval(done); child.kill(); reject(new Error('server did not answer tools/list within 30 s; stdout so far:\n' + out.slice(0, 2000))); }, 30000);
  });
}

describe('stdio server writes only JSON-RPC to stdout', () => {
  for (const entry of ['dist/index.js', 'dist/bundle.cjs']) {
    it(`${entry}: every stdout line parses as JSON-RPC`, async () => {
      const lines = await runAndCollectStdout(entry);
      const bad = lines.filter((l) => { try { return JSON.parse(l).jsonrpc !== '2.0'; } catch { return true; } });
      expect(bad).toEqual([]);
      expect(lines.length).toBeGreaterThanOrEqual(2);
    }, 40000);
  }
});

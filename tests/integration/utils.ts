/**
 * Shared harness for the stdio integration suites (live network).
 *
 * Rules every suite follows (2026-10-24 rewrite — the old suites passed on an
 * empty response, swallowed their own assertion errors in try/catch, or were
 * skipped at module load forever):
 *
 * 1. The server process gets the test's environment. StdioClientTransport only
 *    inherits a small allow-list (HOME, PATH, ...) unless `env` is passed, so
 *    SERPER_API_KEY / GITHUB_TOKEN never reached the server before.
 * 2. A result is checked for what the user would actually see: real results,
 *    the right URL, the requested limit — never just "text.length > 0".
 * 3. A test that needs something the environment may legitimately lack skips
 *    with the reason IN ITS NAME, so the report says why:
 *      - search tests need SERPER_API_KEY (the server is Serper-only by design;
 *        without a key every search returns 0 results, engine
 *        "serper-failed-no-fallback");
 *      - GitHub tests run anonymously (60 req/h per IP) unless GITHUB_TOKEN is
 *        set; an anonymous rate-limit 403 skips at runtime, a 403 WITH a token
 *        fails.
 *    Network failures are NOT skipped: the live job must go red when the
 *    server cannot reach the web.
 */
import { it, expect, type TestContext } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const HAS_SERPER = !!process.env.SERPER_API_KEY;
export const HAS_GITHUB_TOKEN = !!process.env.GITHUB_TOKEN;
export const SEARCH_SKIP_NOTE = ' [SKIPPED: no SERPER_API_KEY — the server is Serper-only, so search returns nothing]';

type TestFn = (ctx: TestContext) => Promise<void> | void;

/** A test that needs a working search backend (Serper). Skips, with the reason in its name, without a key. */
export function searchIt(name: string, fn: TestFn, timeout?: number): void {
  if (HAS_SERPER) it(name, fn, timeout);
  else it.skip(name + SEARCH_SKIP_NOTE, fn, timeout);
}

export interface Started {
  client: Client;
  close(): Promise<void>;
}

/**
 * Spawn `node dist/index.js` (stdio) with the test's env (+ overrides) and connect a client.
 * Server stderr goes to $MCP_TEST_LOG_DIR/<clientName>.server.log when set, else is discarded.
 * Transport errors are rethrown into the test log with their MESSAGE (an Error serialises to {}).
 */
export async function startStdioServer(clientName: string, extraEnv: Record<string, string> = {}): Promise<Started> {
  let stderr: 'ignore' | number = 'ignore';
  const logDir = process.env.MCP_TEST_LOG_DIR;
  if (logDir) {
    fs.mkdirSync(logDir, { recursive: true });
    stderr = fs.openSync(path.join(logDir, `${clientName}.server.log`), 'a');
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...extraEnv })) if (v !== undefined) env[k] = v;
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env,
    stderr,
    stdioBufferMaxSize: 1024 * 1024 * 50,
  } as ConstructorParameters<typeof StdioClientTransport>[0]);
  const client = new Client({ name: clientName, version: '1.0.0' });
  const transportErrors: string[] = [];
  client.onerror = (error) => {
    transportErrors.push(error instanceof Error ? error.message : String(error));
    process.stderr.write(`[${clientName}] MCP transport error: ${transportErrors.at(-1)}\n`);
  };
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close();
      if (typeof stderr === 'number') fs.closeSync(stderr);
      // A stdio server that writes non-JSON to stdout produces transport errors; fail loudly.
      expect(transportErrors, 'stdio transport errors (non-JSON-RPC output on stdout?)').toEqual([]);
    },
  };
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

/** Call a tool and return its text + isError. Protocol-level failures (timeouts) still throw. */
export async function callTool(client: Client, name: string, args: Record<string, unknown>, timeoutMs = 90000): Promise<ToolResult> {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
  const content = (r.content as Array<{ type: string; text?: string }>) || [];
  return { text: content.filter((c) => c.type === 'text').map((c) => c.text || '').join('\n'), isError: !!r.isError };
}

/** Call a tool that must succeed; a tool error fails the test with the server's own message. */
export async function callOk(client: Client, name: string, args: Record<string, unknown>, timeoutMs = 90000): Promise<string> {
  const r = await callTool(client, name, args, timeoutMs);
  if (r.isError) throw new Error(`${name} returned an error: ${r.text.slice(0, 500)}`);
  return r.text;
}

/** Numbered result entries ("**1. Title**" then "URL: http...") in full-web-search / progressive-web-search output. */
export function resultUrls(text: string): string[] {
  return [...text.matchAll(/^\*\*\d+\. .*\*\*\nURL: (https?:\/\/\S+)/gm)].map((m) => m[1]);
}

/** The JSON array embedded in get-web-search-summaries output. */
export function summaryItems(text: string): Array<{ title: string; url: string; description: string }> {
  const m = text.match(/```json\n([\s\S]*?)\n```/);
  if (!m) return [];
  const parsed = JSON.parse(m[1]);
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * GitHub calls run anonymously unless GITHUB_TOKEN is set. Anonymous access is capped at 60 requests/hour per IP,
 * so an anonymous rate-limit refusal skips the test (with the reason); with a token, a 403 is a real failure.
 */
export function skipIfAnonymousGithubRateLimit(ctx: { skip: (note?: string) => void }, r: ToolResult): void {
  if (r.isError && !HAS_GITHUB_TOKEN && /status code 403|rate limit/i.test(r.text)) {
    ctx.skip('GitHub anonymous rate limit (60/h per IP) exhausted; set GITHUB_TOKEN to run this test');
  }
}

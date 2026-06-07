#!/usr/bin/env node
/**
 * Deterministic tool exerciser for mcp-web-search.
 *
 * Drives a fixed battery of representative + malformed tool calls so the
 * learning loop (logs/insights.jsonl) fills with attributed, REAL events —
 * success / no-results / error — across the tools that were just instrumented
 * (get-single-web-page-content, get-website-sitemap, get-github-repo-content,
 * get-pdf-content, list-cached-documents, read-cached-document). It proves the
 * instrumentation works and seeds a baseline; the malformed cases need no
 * network or API keys. Read the result with:
 *   npm run insights <the printed INSIGHTS_LOG path>
 *
 * Usage:
 *   node scripts/dev/exercise.mjs                       # stdio (default), temp insights log
 *   INSIGHTS_LOG=/path.jsonl node scripts/dev/exercise.mjs
 *   node scripts/dev/exercise.mjs --hosted <baseUrl> --token <tenantBearer>
 *
 * Stdio env: INSIGHTS_LOG (default temp, printed), MCP_CLIENT_TYPE (default
 * "exerciser"). The server runs with cwd = repo root so list/read-cached find
 * the existing docs/research-output files for a success case.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..", "..");
const SERVER = path.join(REPO, "dist", "index.js");

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const hostedBase = flag("--hosted");
const hostedToken = flag("--token");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-exercise-"));
const INSIGHTS_LOG = process.env.INSIGHTS_LOG || path.join(tmp, "insights.jsonl");

/** Minimal stdio JSON-RPC MCP client (line-delimited). */
class StdioClient {
  constructor(env) {
    this.env = env; this.proc = null; this.buf = ""; this.pending = new Map(); this.nextId = 1;
  }
  async start() {
    this.proc = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"], cwd: REPO, env: this.env });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (c) => this._onData(c));
    this.proc.stderr.on("data", () => {});
    await this._request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "exerciser", version: "1.0.0" } });
    this._notify("notifications/initialized", {});
    await new Promise((r) => setTimeout(r, 150));
  }
  _onData(chunk) {
    this.buf += chunk; let idx;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).trim(); this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (m.id != null && this.pending.has(m.id)) { this.pending.get(m.id).resolve(m); this.pending.delete(m.id); } } catch { /* non-JSON */ }
    }
  }
  _notify(method, params) { this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); }
  _request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 30000);
    });
  }
  async call(name, args) { const r = await this._request("tools/call", { name, arguments: args }); return r.result || { isError: true, content: [{ type: "text", text: JSON.stringify(r.error || {}) }] }; }
  async stop() { if (this.proc) { this.proc.kill(); this.proc = null; } }
}

/** SDK client over the hosted HTTP transport (for --hosted). */
class HostedClient {
  constructor(base, token) { this.base = base; this.token = token; }
  async start() {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const url = new URL(this.base.replace(/\/$/, "") + "/mcp");
    this.transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${this.token}` } } });
    this.client = new Client({ name: "exerciser", version: "1.0.0" });
    await this.client.connect(this.transport);
  }
  async call(name, args) { return this.client.callTool({ name, arguments: args }); }
  async stop() { try { await this.client.close(); } catch { /* best effort */ } }
}

const textOf = (r) => (r && r.content && r.content[0] && r.content[0].text) || "";

async function main() {
  const env = { ...process.env, INSIGHTS_LOG, MCP_CLIENT_TYPE: process.env.MCP_CLIENT_TYPE || "exerciser" };
  const client = hostedBase ? new HostedClient(hostedBase, hostedToken) : new StdioClient(env);
  console.log(`[exercise] web-search (${hostedBase ? "hosted " + hostedBase : "stdio"}) — INSIGHTS_LOG=${INSIGHTS_LOG}`);
  await client.start();

  const run = async (label, name, args) => {
    try { const r = await client.call(name, args); console.log(`  ${r && r.isError ? "·" : "✓"} ${label}`); return r; }
    catch (err) { console.log(`  ✗ ${label} — ${err.message}`); return null; }
  };

  // 1) list-cached-documents → success; capture a real filename for the read.
  const listed = await run("list-cached-documents OK", "list-cached-documents", {});
  const m = textOf(listed).match(/([\w.-]+\.(?:md|json|ya?ml))/);
  const realFile = m ? m[1] : null;

  // 2) read a real cached file → success (if one exists), else note it.
  if (realFile) await run(`read-cached-document OK (${realFile})`, "read-cached-document", { fileName: realFile });
  else console.log("  (no cached file found to exercise a read success — skipping)");

  // 3) read a missing file → no-results.
  await run("read-cached-document no-results", "read-cached-document", { fileName: "definitely-missing-xyz-12345.md" });

  // 4-7) malformed / unreachable inputs → error / no-results (no network keys needed).
  await run("get-single-web-page-content ERROR", "get-single-web-page-content", { url: "http://127.0.0.1:1/nope" });
  await run("get-website-sitemap ERROR/none", "get-website-sitemap", { url: "https://nonexistent-domain-xyz-99999.invalid" });
  await run("get-github-repo-content ERROR/none", "get-github-repo-content", { url: "https://github.com/leanzero-srl/nonexistent-repo-xyz-99999", mode: "list" });
  await run("get-pdf-content ERROR", "get-pdf-content", { url: "http://127.0.0.1:1/nope.pdf" });

  await new Promise((r) => setTimeout(r, 300)); // let async appends flush
  await client.stop();

  // tally (stdio only — hosted writes to the server's own DATA_DIR log)
  if (!hostedBase && fs.existsSync(INSIGHTS_LOG)) {
    const counts = {};
    for (const line of fs.readFileSync(INSIGHTS_LOG, "utf8").split("\n").filter(Boolean)) {
      try { const e = JSON.parse(line); counts[e.event] = (counts[e.event] || 0) + 1; } catch { /* skip */ }
    }
    console.log(`[exercise] events by type: ${JSON.stringify(counts)}`);
    console.log(`[exercise] review with:  npm run insights "${INSIGHTS_LOG}"`);
  } else if (hostedBase) {
    console.log(`[exercise] hosted run — events went to the server's DATA_DIR/logs/insights.jsonl`);
  }
}

main().catch((err) => { console.error("[exercise] fatal:", err); process.exit(1); });

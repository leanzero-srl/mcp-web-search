#!/usr/bin/env node
/**
 * Insights report — summarize the JSONL learning log so the creator can see
 * how the MCP is actually used and where it falls short.
 *
 *   npm run insights            # reads INSIGHTS_LOG | <DATA_DIR|cwd>/logs/insights.jsonl
 *   node scripts/insights-report.mjs /path/to/insights.jsonl
 *
 * Pure Node, no deps. Works for both the doc-processor and web-search logs
 * (fields differ; it adapts).
 */
import fs from "fs";
import path from "path";

function resolvePath() {
  if (process.argv[2]) return process.argv[2];
  if (process.env.INSIGHTS_LOG) return process.env.INSIGHTS_LOG;
  const base = process.env.DATA_DIR || process.cwd();
  return path.join(base, "logs", "insights.jsonl");
}

const file = resolvePath();
if (!fs.existsSync(file)) {
  console.log(`No insights log yet at: ${file}`);
  console.log("It fills in as the tools are used. Pass a path or set INSIGHTS_LOG to point elsewhere.");
  process.exit(0);
}

const rows = fs.readFileSync(file, "utf8")
  .split("\n").filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

if (!rows.length) { console.log(`Insights log is empty: ${file}`); process.exit(0); }

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "—");
const isFail = (e) => e === "no-results" || e === "failure" || e === "PLAIN_TEXT";

console.log(`\n📊 MCP Insights — ${rows.length} events`);
console.log(`   file: ${file}`);
console.log(`   span: ${rows[0].ts} → ${rows[rows.length - 1].ts}\n`);

const byTool = {};
for (const r of rows) {
  const t = r.tool || "?";
  (byTool[t] ??= { total: 0, ok: 0, fail: 0 }).total++;
  if (r.event === "success") byTool[t].ok++;
  else if (isFail(r.event)) byTool[t].fail++;
}
console.log("Per tool:");
for (const [t, s] of Object.entries(byTool).sort((a, b) => b[1].total - a[1].total)) {
  console.log(`  ${t.padEnd(30)} ${String(s.total).padStart(5)} calls | ${String(s.ok).padStart(4)} ok / ${String(s.fail).padStart(4)} fail | success ${pct(s.ok, s.ok + s.fail)}`);
}

const fails = rows.filter((r) => isFail(r.event) && r.query);
if (fails.length) {
  const q = {};
  for (const r of fails) q[r.query] = (q[r.query] || 0) + 1;
  console.log("\nTop failing queries (improve coverage here):");
  Object.entries(q).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .forEach(([query, n]) => console.log(`  ${String(n).padStart(3)}×  ${query}`));
}

const shaped = rows.filter((r) => r.category || r.format);
if (shaped.length) {
  const c = {};
  for (const r of shaped) {
    const k = `${r.format || "?"}${r.category ? " / " + r.category : ""}`;
    c[k] = (c[k] || 0) + 1;
  }
  console.log("\nBy format / category:");
  Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .forEach(([k, n]) => console.log(`  ${String(n).padStart(4)}×  ${k}`));
}

const clients = {};
for (const r of rows) {
  const k = r.client || "unknown";
  (clients[k] ??= { n: 0, memo: 0 }).n++;
  if (r.memoryCapable) clients[k].memo++;
}
console.log("\nClients:");
Object.entries(clients).sort((a, b) => b[1].n - a[1].n)
  .forEach(([k, v]) => console.log(`  ${k.padEnd(24)} ${String(v.n).padStart(5)} events${v.memo ? ` (${v.memo} memory-capable)` : ""}`));

console.log("");

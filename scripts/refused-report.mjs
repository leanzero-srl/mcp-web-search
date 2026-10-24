#!/usr/bin/env node
/**
 * Refused-request report — summarise refused.jsonl (401/403/404/405/429 audit log).
 *
 *   npm run refused                 # REFUSED_LOG | dir(INSIGHTS_LOG) | <DATA_DIR|cwd>/logs/refused.jsonl
 *   node scripts/refused-report.mjs /path/to/refused.jsonl [--top N]
 *
 * Reads refused.jsonl.1 (the rotated generation) too when it exists.
 * Prints counts by status, per day, top paths, top user agents, top X-Forwarded-For.
 * Pure Node, no deps. Same script in mcp-web-search and mcp-doc-processor.
 */
import fs from "fs";
import path from "path";

const args = process.argv.slice(2);
const topIdx = args.indexOf("--top");
const TOP = topIdx >= 0 ? Number(args[topIdx + 1]) || 10 : 10;
const positional = args.filter((a, i) => !a.startsWith("--") && !(topIdx >= 0 && i === topIdx + 1));

function resolvePath() {
  if (positional[0]) return positional[0];
  if (process.env.REFUSED_LOG) return process.env.REFUSED_LOG;
  const dir = process.env.INSIGHTS_LOG
    ? path.dirname(process.env.INSIGHTS_LOG)
    : path.join(process.env.DATA_DIR || process.cwd(), "logs");
  return path.join(dir, "refused.jsonl");
}

const file = resolvePath();
const files = [file + ".1", file].filter((f) => fs.existsSync(f));
if (!files.length) {
  console.log(`No refused log yet at: ${file}`);
  process.exit(0);
}

const rows = files
  .flatMap((f) => fs.readFileSync(f, "utf8").split("\n"))
  .filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && r.status);

if (!rows.length) { console.log(`Refused log is empty: ${file}`); process.exit(0); }

const count = (key) => {
  const m = new Map();
  for (const r of rows) {
    const k = typeof key === "function" ? key(r) : r[key];
    const kk = k === undefined || k === null || k === "" ? "(none)" : String(k);
    m.set(kk, (m.get(kk) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const show = (title, entries, limit = TOP) => {
  console.log(`\n${title}`);
  for (const [k, n] of entries.slice(0, limit)) console.log(`  ${String(n).padStart(7)}  ${k}`);
  if (entries.length > limit) console.log(`  ... ${entries.length - limit} more`);
};

const first = rows[0].ts, last = rows[rows.length - 1].ts;
console.log(`\nRefused requests: ${rows.length}  (${first} .. ${last})`);
console.log(`files: ${files.join(", ")}`);
show("By status", count("status"), 20);
show("By server", count("server"), 5);
show("Per day (UTC)", count((r) => String(r.ts || "").slice(0, 10)).sort((a, b) => a[0].localeCompare(b[0])), 60);
show("Per day x status", count((r) => `${String(r.ts || "").slice(0, 10)} ${r.status}`).sort((a, b) => a[0].localeCompare(b[0])), 120);
show(`Top paths`, count((r) => `${r.method || "?"} ${r.path}`));
show(`Top user agents`, count("ua"));
show(`Top X-Forwarded-For (first hop)`, count("xff"));
show(`401s carrying an Authorization header (bad/revoked keys)`, count((r) => (r.status === 401 ? (r.auth ? "auth header present" : "no auth header") : undefined)).filter(([k]) => k !== "(none)"), 5);
console.log("");

/**
 * Insights log + learning nudges.
 *
 * Records notable search outcomes (success / no-results) as JSONL so the MCP's
 * creator can mine real usage and improve the tools. Separately, for
 * memory-capable agents, returns a one-line nudge to append to the response so
 * the agent saves "how to search better" notes. Chat UIs (LM Studio) get the
 * log entry but no nudge.
 */

import * as fs from 'fs';
import * as path from 'path';

import { logger } from './logger.js';
import { getClientInfo, clientCanPersistMemory } from './client-detect.js';

function insightsPath(): string {
  if (process.env.INSIGHTS_LOG) return process.env.INSIGHTS_LOG;
  const base = process.env.DATA_DIR || process.cwd();
  return path.join(base, 'logs', 'insights.jsonl');
}

let dirReady = false;

/** Append one structured insight event (best-effort, never throws). */
export function logInsight(event: Record<string, unknown>): void {
  try {
    const file = insightsPath();
    if (!dirReady) { fs.mkdirSync(path.dirname(file), { recursive: true }); dirReady = true; }
    fs.appendFile(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n', () => {});
  } catch (err) {
    logger.warn('[insights] failed to record event', { error: (err as Error).message });
  }
}

// IT JUST WORKS: teach once per session, don't nag. A nudge for a given
// situation (keyed) is returned at most once per process (= per stdio session).
const seenNudges = new Set<string>();
function once(key: string): boolean {
  if (seenNudges.has(key)) return false;
  seenNudges.add(key);
  return true;
}

/**
 * Generic learning nudge for any tool outcome. Records the event always; returns
 * a one-line nudge only for memory-capable agents, deduped per session by key.
 */
export function toolLearning(tool: string, event: string, detail: Record<string, unknown>, suggestion: string): string {
  const client = getClientInfo()?.name || 'unknown';
  const canMemo = clientCanPersistMemory();
  logInsight({ server: 'web-search', tool, event, client, memoryCapable: canMemo, ...detail });
  if (!canMemo || !suggestion) return '';
  if (!once(`${tool}:${event}`)) return '';
  return `\n\n💡 If you keep long-term memory: ${suggestion}`;
}

/**
 * Record a search outcome and, for memory-capable agents, return a one-line
 * nudge to append to the response text. Returns '' for chat UIs.
 *
 * @param tool - logical tool name (e.g. "full-web-search")
 * @param query - the user's query
 * @param success - true if results were found
 * @param count - number of results
 */
export function searchLearning(tool: string, query: string, success: boolean, count: number): string {
  const suggestion = success
    ? `note what made this search work (the query phrasing and that \`${tool}\` fit) so you reach the answer faster for similar questions.`
    : `record a better strategy for queries like "${query}" — broaden or add context to the terms, try \`site:\`/exact-phrase operators, switch tool (full-web-search ↔ get-web-search-summaries), and save any phrasing that finally works.`;
  return toolLearning(tool, success ? 'success' : 'no-results', { query, count }, suggestion);
}

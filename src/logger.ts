/**
 * Tiny zero-dep JSON-stderr logger.
 *
 * Why this exists: stdio MCP uses stdout exclusively for the JSON-RPC frame
 * stream — anything written to stdout by the server (or by libraries it
 * imports) corrupts the protocol. The previous approach in `index.ts`
 * reassigned `console.log` and `console.error` globally so every imported
 * package (Cheerio, Playwright, Axios) inherited the override. That worked but
 * coupled every dependency to our log format and made it impossible to silence
 * libraries independently.
 *
 * This module provides a structured logger that *only* writes to `process.stderr`
 * and never touches stdout. Hot paths import `logger` directly; library noise is
 * handled separately (or just left to print to stderr, which is harmless under
 * stdio MCP).
 *
 * Levels are filtered by `LOG_LEVEL` (debug | info | warn | error). Default is
 * `info` in production, `debug` when `DEBUG=true` is set.
 */

import { installStdioErrorGuards, isSinkError, noteDroppedWrite } from './stdio-guard.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveMinLevel(): number {
  const explicit = (process.env.LOG_LEVEL || '').toLowerCase() as Level;
  if (explicit && explicit in LEVEL_ORDER) return LEVEL_ORDER[explicit];
  if (process.env.DEBUG === 'true') return LEVEL_ORDER.debug;
  return LEVEL_ORDER.info;
}

const minLevel = resolveMinLevel();

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < minLevel) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ?? {}),
  });
  // Always stderr — never stdout (MCP stdio uses stdout for JSON-RPC frames).
  writeStderr(line + '\n');
}

/**
 * Write to stderr without ever taking the process down: a full disk under the
 * launchd log file (ENOSPC) or a closed reader (EPIPE) drops the line and
 * counts it (stdio-guard.ts). Logging resumes by itself once the sink works.
 */
function writeStderr(text: string): void {
  installStdioErrorGuards();
  try {
    process.stderr.write(text, (err) => { if (err) noteDroppedWrite(); });
  } catch (err) {
    if (!isSinkError(err)) throw err;
    noteDroppedWrite();
  }
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info:  (msg: string, meta?: Record<string, unknown>) => emit('info',  msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => emit('warn',  msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};

/**
 * Installs a stdio-safe console shim so any third-party `console.log` calls in
 * the dependency graph go to stderr instead of corrupting the MCP frame stream.
 * This is intentionally minimal — we don't try to JSON-encode arbitrary library
 * output, just route it to stderr verbatim.
 *
 * Call once at process startup, before transport.connect().
 */
export function installStdioSafeConsoleShim(): void {
  const stringify = (args: unknown[]): string =>
    args
      .map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
      .join(' ');

  console.log = (...args: unknown[]) => {
    writeStderr(`[stdout-redirect] ${stringify(args)}\n`);
  };
  console.info = console.log;
  console.warn = (...args: unknown[]) => {
    writeStderr(`[warn] ${stringify(args)}\n`);
  };
  console.error = (...args: unknown[]) => {
    writeStderr(`[error] ${stringify(args)}\n`);
  };
  console.debug = (...args: unknown[]) => {
    if (minLevel <= LEVEL_ORDER.debug) {
      writeStderr(`[debug] ${stringify(args)}\n`);
    }
  };
}

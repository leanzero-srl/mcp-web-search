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
  process.stderr.write(line + '\n');
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
    process.stderr.write(`[stdout-redirect] ${stringify(args)}\n`);
  };
  console.info = console.log;
  console.warn = (...args: unknown[]) => {
    process.stderr.write(`[warn] ${stringify(args)}\n`);
  };
  console.error = (...args: unknown[]) => {
    process.stderr.write(`[error] ${stringify(args)}\n`);
  };
  console.debug = (...args: unknown[]) => {
    if (minLevel <= LEVEL_ORDER.debug) {
      process.stderr.write(`[debug] ${stringify(args)}\n`);
    }
  };
}

/**
 * Refused-request audit log (security audit 2026-10-24).
 *
 * insights.jsonl records only ACCEPTED tool calls, so scans and brute force
 * against the public Funnel endpoint were invisible. This middleware, mounted
 * FIRST in buildApp(), appends one JSONL line per refused response (401, 403,
 * 404, 405, 429) to <logs dir>/refused.jsonl — the same logs directory as
 * insights.jsonl (INSIGHTS_LOG's dir, else <DATA_DIR|cwd>/logs). Override with
 * REFUSED_LOG.
 *
 * NEVER logged: the Authorization header or any bearer, cookies, the query
 * string (it can carry ?serper_key / ?github_token), the body, any other
 * header VALUE. Only header NAMES (hn) and whether an Authorization header was
 * present (auth: true/false) are recorded, plus the Tailscale identity headers.
 *
 * Writes are async, serialised, capped in flight and swallow every error — an
 * audit log must never break or slow a request. Rotation: when the file
 * exceeds REFUSED_LOG_MAX_BYTES (default 20 MB) it is renamed to
 * refused.jsonl.1 (one generation kept).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

export const REFUSED_STATUSES = new Set([401, 403, 404, 405, 429]);
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const MAX_PENDING = 1000;
// Tailscale Serve/Funnel identity headers (values are logins/flags, not secrets).
const TAILSCALE_HEADERS = ['tailscale-funnel-request', 'tailscale-user-login', 'tailscale-user-name'];

export function refusedLogPath(): string {
  if (process.env.REFUSED_LOG) return process.env.REFUSED_LOG;
  const dir = process.env.INSIGHTS_LOG
    ? path.dirname(process.env.INSIGHTS_LOG)
    : path.join(process.env.DATA_DIR || process.cwd(), 'logs');
  return path.join(dir, 'refused.jsonl');
}

const clip = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string' || !v) return undefined;
  return v.length > max ? v.slice(0, max) : v;
};

/** Build the log record. Exported for tests. Never reads header values except the allowlisted ones. */
export function buildRefusedRecord(server: string, req: Request, status: number): Record<string, unknown> {
  const rawPath = String(req.originalUrl || req.url || '').split('?')[0];
  const xffRaw = req.headers['x-forwarded-for'];
  const xffStr = Array.isArray(xffRaw) ? xffRaw.join(',') : xffRaw;
  const hops = typeof xffStr === 'string' ? xffStr.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const rec: Record<string, unknown> = {
    ts: new Date().toISOString(),
    server,
    status,
    method: clip(req.method, 16),
    path: clip(rawPath, 200),
    ua: clip(req.headers['user-agent'], 160),
    xff: clip(hops[0], 64),
    auth: Boolean(req.headers.authorization),
    hn: Object.keys(req.headers).slice(0, 40).join(','),
  };
  if (hops.length > 1) rec.xff_last = clip(hops[hops.length - 1], 64);
  for (const h of TAILSCALE_HEADERS) {
    const v = req.headers[h];
    if (typeof v === 'string' && v) rec[h] = clip(v, 128);
  }
  return rec;
}

let chain: Promise<void> = Promise.resolve();
let pending = 0;
let dirReady = false;

function maxBytes(): number {
  const n = Number(process.env.REFUSED_LOG_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

/** Queue one line; rotation + append run serially off the request path. */
export function appendRefused(rec: Record<string, unknown>): void {
  if (pending >= MAX_PENDING) return; // flood: drop rather than grow memory
  pending++;
  const line = JSON.stringify(rec) + '\n';
  chain = chain
    .then(async () => {
      const file = refusedLogPath();
      if (!dirReady) { await fs.promises.mkdir(path.dirname(file), { recursive: true }); dirReady = true; }
      const st = await fs.promises.stat(file).catch(() => null);
      if (st && st.size > maxBytes()) await fs.promises.rename(file, file + '.1');
      await fs.promises.appendFile(file, line, { mode: 0o600 });
    })
    .catch(() => { /* never break a request over the audit log */ })
    .finally(() => { pending--; });
}

/** Resolves when every queued write has settled (tests). */
export function flushRefused(): Promise<void> { return chain; }

export function refusedLogger(server: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    res.on('finish', () => {
      try {
        if (REFUSED_STATUSES.has(res.statusCode)) appendRefused(buildRefusedRecord(server, req, res.statusCode));
      } catch { /* ignore */ }
    });
    next();
  };
}

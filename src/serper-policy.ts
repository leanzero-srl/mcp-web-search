/**
 * Which Serper key a search may spend, and whether it may spend it now
 * (2026-11-11).
 *
 * Hosted HTTP callers (requestContext.hosted === true):
 *   - class 'public' (default for every key, always for /v1/provision): ONLY
 *     the caller's own X-Serper-Key / ?serper_key. Never process.env.SERPER_API_KEY.
 *     No key = a clear "bring your own key" error.
 *   - class 'internal' (admin-minted, tailnet-only): ONLY the server-side key
 *     read from INTERNAL_SERPER_KEY_FILE (default <DATA_DIR>/internal-serper.key).
 *     A caller-sent key is ignored. The file is refused if group/other-readable.
 *     Missing/refused file = a clear error; never a silent fallback.
 * stdio (no hosted context): unchanged, caller key else SERPER_API_KEY.
 *
 * The key value is never logged, returned or written anywhere.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import axios from 'axios';
import { requestContext } from './request-context.js';
import { logger } from './logger.js';
import { recordSerperRequest, serperRefusal, type KeySource, type TenantClass } from './usage-meter.js';

/** A refusal the caller should read as plain words (becomes an isError tool result). */
export class SerperPolicyError extends Error {
  constructor(public readonly reason: 'no-key' | 'internal-key-missing' | 'limit', message: string) {
    super(message);
    this.name = 'SerperPolicyError';
  }
}

export function internalKeyPath(): string {
  return process.env.INTERNAL_SERPER_KEY_FILE
    || path.join(process.env.DATA_DIR || process.cwd(), 'internal-serper.key');
}

let keyCache: { file: string; mtimeMs: number; size: number; mode: number; key: string | null } | null = null;
let lastRefusalLogged = '';

/** The server-side internal Serper key, or null (missing, empty or too open). */
export function loadInternalSerperKey(): string | null {
  const file = internalKeyPath();
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    keyCache = null;
    return null;
  }
  if (keyCache && keyCache.file === file && keyCache.mtimeMs === st.mtimeMs && keyCache.size === st.size && keyCache.mode === st.mode) {
    return keyCache.key;
  }
  let key: string | null = null;
  if ((st.mode & 0o077) !== 0) {
    const msg = `${file} is readable by group/other (mode ${(st.mode & 0o777).toString(8)}); refusing to use it. chmod 600 it.`;
    if (lastRefusalLogged !== msg) { logger.error('[serper] internal key file refused', { reason: msg }); lastRefusalLogged = msg; }
  } else {
    try {
      key = fs.readFileSync(file, 'utf8').trim() || null;
    } catch {
      key = null;
    }
  }
  keyCache = { file, mtimeMs: st.mtimeMs, size: st.size, mode: st.mode, key };
  return key;
}

function ownKeyHashes(): Set<string> {
  return new Set((process.env.OWN_SERPER_KEY_SHA256 || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

export function classifyCallerKey(key: string): KeySource {
  const h = createHash('sha256').update(key).digest('hex');
  return ownKeyHashes().has(h) ? 'own' : 'byo';
}

export interface ResolvedSerperKey {
  apiKey: string | null;
  /** null on stdio (not metered). */
  keySource: KeySource | null;
  tenantId: string | null;
  tenantClass: TenantClass | null;
}

const NO_KEY_MESSAGE =
  'This search needs your own Serper API key. Send it in the X-Serper-Key header (or the serper_key query parameter). ' +
  'Hosted public keys never use the server\'s search credits. A free key is available at https://serper.dev.';
const INTERNAL_MISSING_MESSAGE =
  'Web search is unavailable for this internal key: the server\'s internal Serper key is not configured ' +
  '(INTERNAL_SERPER_KEY_FILE missing, empty or not mode 600). Ask the server operator to fix it.';

/**
 * Resolve the key for the current request. Throws SerperPolicyError for a
 * hosted caller who may not search (no own key / internal key unavailable).
 */
export function resolveSerperKey(): ResolvedSerperKey {
  const ctx = requestContext.getStore();
  if (!ctx || !ctx.hosted) {
    return { apiKey: ctx?.serperKey || process.env.SERPER_API_KEY || null, keySource: null, tenantId: null, tenantClass: null };
  }
  const tenantId = ctx.tenantId || 'unknown';
  const cls: TenantClass = ctx.tenantClass === 'internal' ? 'internal' : 'public';
  if (cls === 'internal') {
    const key = loadInternalSerperKey();
    if (!key) throw new SerperPolicyError('internal-key-missing', INTERNAL_MISSING_MESSAGE);
    return { apiKey: key, keySource: 'internal', tenantId, tenantClass: cls };
  }
  if (!ctx.serperKey) throw new SerperPolicyError('no-key', NO_KEY_MESSAGE);
  return { apiKey: ctx.serperKey, keySource: classifyCallerKey(ctx.serperKey), tenantId, tenantClass: cls };
}

/**
 * Call right before each upstream Serper request: refuses (throws) when a cap
 * or budget is used up, else counts the request.
 */
export function admitSerperRequest(r: ResolvedSerperKey): void {
  if (!r.keySource || !r.tenantId || !r.tenantClass) return; // stdio: not metered
  const refusal = serperRefusal(r.tenantId, r.tenantClass, r.keySource);
  if (refusal) {
    logger.info('[usage] Serper request refused', { tenant: r.tenantId, class: r.tenantClass, keySource: r.keySource });
    throw new SerperPolicyError('limit', refusal);
  }
  recordSerperRequest(r.tenantId, r.tenantClass, r.keySource);
}

// ---- balance (free endpoint) ---------------------------------------------------

const BALANCE_TTL_MS = 10 * 60 * 1000;
let balanceCache: { at: number; balance: number | null } | null = null;
let balanceInFlight: Promise<number | null> | null = null;

/**
 * Credits left on the internal key's Serper account (GET /account costs no
 * credit), cached for 10 minutes. null when there is no internal key or the
 * call fails.
 */
export async function getSerperBalance(): Promise<number | null> {
  if (balanceCache && Date.now() - balanceCache.at < BALANCE_TTL_MS) return balanceCache.balance;
  if (balanceInFlight) return balanceInFlight;
  balanceInFlight = (async () => {
    const key = loadInternalSerperKey();
    let balance: number | null = null;
    if (key) {
      try {
        const res = await axios.get('https://google.serper.dev/account', {
          headers: { 'X-API-KEY': key },
          timeout: 5000,
        });
        const b = Number(res?.data?.balance);
        balance = Number.isFinite(b) ? b : null;
      } catch (err) {
        logger.warn('[serper] balance check failed', { error: (err as Error).message });
      }
    }
    balanceCache = { at: Date.now(), balance };
    return balance;
  })().finally(() => { balanceInFlight = null; });
  return balanceInFlight;
}

/** @internal tests */
export function resetSerperPolicyCachesForTests(): void {
  keyCache = null;
  balanceCache = null;
}

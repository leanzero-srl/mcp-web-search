/**
 * Usage meter for the hosted server (2026-11-11).
 *
 * Counts, per UTC day and per tenant:
 *   - tool calls and tool errors, by tenant class (public | internal)
 *   - every upstream Serper API request (one request = one credit), by
 *     keySource: 'internal' (the server-side key), 'own' (a caller-sent key
 *     whose sha256 is in OWN_SERPER_KEY_SHA256: our own key, e.g. the website)
 *     or 'byo' (anyone else's key).
 *
 * Enforces, before each upstream Serper request:
 *   - a per-key monthly cap (PUBLIC_MONTHLY_SERPER_CAP / INTERNAL_MONTHLY_SERPER_CAP)
 *   - global budgets on OUR credits: OWN_DAILY_BUDGET / OWN_MONTHLY_BUDGET
 *     (keySource own) and INTERNAL_DAILY_BUDGET / INTERNAL_MONTHLY_BUDGET
 *     (keySource internal). byo requests spend the caller's credits, so only
 *     the per-key cap applies to them.
 * At >= 80 % of a budget it logs one WARN line per budget per period.
 *
 * Persisted to <DATA_DIR>/usage/usage-YYYY-MM.json (mode 0600, atomic
 * tmp+rename, debounced by USAGE_FLUSH_MS, default 2000 ms). Never holds a
 * key, a key hash or a bearer: only tenant ids, classes and counters.
 *
 * Disabled (every call a no-op, every check allows) until enableUsageMeter()
 * runs: the HTTP transport enables it; stdio never does.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { logger } from './logger.js';

export type TenantClass = 'public' | 'internal';
export type KeySource = 'internal' | 'own' | 'byo';

interface Counts { calls: number; serper: number; errors: number }
interface DayBucket {
  calls: Record<TenantClass, number>;
  serper: Record<KeySource, number>;
  errors: Record<TenantClass, number>;
  tenants: Record<string, Counts>;
}
interface TenantMonth extends Counts { class: TenantClass }
interface MonthFile {
  version: 1;
  month: string;
  days: Record<string, DayBucket>;
  tenants: Record<string, TenantMonth>;
  /** budget-period ids already warned about, e.g. "ownDaily:2026-11-11". */
  warned: string[];
}

/** Defaults. The measured basis for each is in the README ("Serper credits"). */
export const USAGE_DEFAULTS = {
  PUBLIC_MONTHLY_SERPER_CAP: 300,
  INTERNAL_MONTHLY_SERPER_CAP: 3000,
  OWN_DAILY_BUDGET: 150,
  OWN_MONTHLY_BUDGET: 2000,
  INTERNAL_DAILY_BUDGET: 500,
  INTERNAL_MONTHLY_BUDGET: 8000,
} as const;
type LimitName = keyof typeof USAGE_DEFAULTS;

const WARN_PCT = 80;

function limit(name: LimitName): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : USAGE_DEFAULTS[name];
}

let enabled = false;
let dir = '';
let state: MonthFile | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let writeChain: Promise<void> = Promise.resolve();

const dayKey = (d = new Date()): string => d.toISOString().slice(0, 10);
const monthKey = (d = new Date()): string => d.toISOString().slice(0, 7);
const fileFor = (month: string): string => path.join(dir, `usage-${month}.json`);

function emptyDay(): DayBucket {
  return { calls: { public: 0, internal: 0 }, serper: { internal: 0, own: 0, byo: 0 }, errors: { public: 0, internal: 0 }, tenants: {} };
}

function readMonth(month: string): MonthFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(month), 'utf8')) as MonthFile;
    if (parsed && parsed.month === month && parsed.days && parsed.tenants) {
      parsed.warned = Array.isArray(parsed.warned) ? parsed.warned : [];
      return parsed;
    }
  } catch { /* missing or unreadable: start empty */ }
  return null;
}

function current(): MonthFile {
  const month = monthKey();
  if (!state || state.month !== month) {
    if (state) writeNow(state); // close out the previous month
    state = readMonth(month) || { version: 1, month, days: {}, tenants: {}, warned: [] };
  }
  return state;
}

function writeNow(snapshot: MonthFile): Promise<void> {
  const body = JSON.stringify(snapshot);
  const target = fileFor(snapshot.month);
  const run = writeChain.then(async () => {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    await fs.promises.writeFile(tmp, body, { mode: 0o600 });
    await fs.promises.rename(tmp, target);
  });
  writeChain = run.catch((err) => {
    logger.warn('[usage] could not persist usage file', { error: (err as Error).message });
  });
  return writeChain;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  const ms = Number(process.env.USAGE_FLUSH_MS) || 2000;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (state) void writeNow(state);
  }, ms);
  flushTimer.unref();
}

/** Turn the meter on (HTTP transport). Reads the current month from disk. */
export function enableUsageMeter(dataDir: string): void {
  enabled = true;
  dir = path.join(dataDir, 'usage');
  state = null;
  current();
}

export function usageMeterEnabled(): boolean { return enabled; }

/** Write pending counters now (tests, shutdown). */
export async function flushUsage(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (enabled && state) await writeNow(state);
  await writeChain;
}

/** Synchronous best-effort flush for process exit. */
export function flushUsageSync(): void {
  if (!enabled || !state) return;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = fileFor(state.month);
    const tmp = `${target}.tmp.${process.pid}.exit`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch { /* best effort */ }
}

/** @internal tests: drop the in-memory state and re-read it from disk. */
export function reloadUsageForTests(): void {
  state = null;
  current();
}

function bump(tenantId: string, cls: TenantClass, field: keyof Counts, keySource?: KeySource): void {
  const s = current();
  const day = (s.days[dayKey()] ||= emptyDay());
  const td = (day.tenants[tenantId] ||= { calls: 0, serper: 0, errors: 0 });
  const tm = (s.tenants[tenantId] ||= { class: cls, calls: 0, serper: 0, errors: 0 });
  tm.class = cls;
  td[field]++;
  tm[field]++;
  if (field === 'calls') day.calls[cls]++;
  else if (field === 'errors') day.errors[cls]++;
  else if (keySource) day.serper[keySource]++;
  scheduleFlush();
}

export function recordToolCall(tenantId: string, cls: TenantClass): void {
  if (enabled) bump(tenantId, cls, 'calls');
}

export function recordToolError(tenantId: string, cls: TenantClass): void {
  if (enabled) bump(tenantId, cls, 'errors');
}

// ---- budgets -----------------------------------------------------------------

type BudgetName = 'ownDaily' | 'ownMonthly' | 'internalDaily' | 'internalMonthly';
const BUDGETS: Record<BudgetName, { source: KeySource; period: 'day' | 'month'; env: LimitName }> = {
  ownDaily: { source: 'own', period: 'day', env: 'OWN_DAILY_BUDGET' },
  ownMonthly: { source: 'own', period: 'month', env: 'OWN_MONTHLY_BUDGET' },
  internalDaily: { source: 'internal', period: 'day', env: 'INTERNAL_DAILY_BUDGET' },
  internalMonthly: { source: 'internal', period: 'month', env: 'INTERNAL_MONTHLY_BUDGET' },
};

function nextDayStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}
function nextMonthStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

function budgetUsed(name: BudgetName): number {
  const b = BUDGETS[name];
  const s = current();
  if (b.period === 'day') return s.days[dayKey()]?.serper[b.source] || 0;
  return Object.values(s.days).reduce((n, d) => n + (d.serper[b.source] || 0), 0);
}

function budgetView(name: BudgetName): { used: number; limit: number; pct: number; warn: boolean; resetsAt: string } {
  const used = budgetUsed(name);
  const lim = limit(BUDGETS[name].env);
  const pct = Math.round((used / lim) * 1000) / 10;
  const resetsAt = (BUDGETS[name].period === 'day' ? nextDayStartUtc() : nextMonthStartUtc()).toISOString();
  return { used, limit: lim, pct, warn: pct >= WARN_PCT, resetsAt };
}

const fmtReset = (d: Date): string => `${d.toISOString().slice(0, 10)} 00:00 UTC`;

/**
 * Null when one more upstream Serper request is allowed for this tenant and key
 * source, else a plain-words refusal: which limit, the number, when it resets.
 */
export function serperRefusal(tenantId: string, cls: TenantClass, keySource: KeySource): string | null {
  if (!enabled) return null;
  const s = current();
  const capName: LimitName = cls === 'internal' ? 'INTERNAL_MONTHLY_SERPER_CAP' : 'PUBLIC_MONTHLY_SERPER_CAP';
  const cap = limit(capName);
  const usedByKey = s.tenants[tenantId]?.serper || 0;
  if (usedByKey >= cap) {
    return `Search limit reached: this key has used ${usedByKey} of its ${cap} web searches for ${s.month} ` +
      `(the monthly limit per key). It resets on ${fmtReset(nextMonthStartUtc())}. Fetching pages by URL still works.`;
  }
  for (const name of Object.keys(BUDGETS) as BudgetName[]) {
    const b = BUDGETS[name];
    if (b.source !== keySource) continue;
    const v = budgetView(name);
    if (v.used >= v.limit) {
      const whose = keySource === 'internal' ? 'internal searches on the server\'s Serper key' : 'searches paid by the server operator\'s Serper key';
      const period = b.period === 'day' ? 'daily' : 'monthly';
      const reset = b.period === 'day' ? nextDayStartUtc() : nextMonthStartUtc();
      const tail = keySource === 'own'
        ? ' To keep searching now, send your own Serper key in the X-Serper-Key header (free at https://serper.dev).'
        : '';
      return `Search limit reached: the ${period} budget for ${whose} is used up (${v.used} of ${v.limit}). ` +
        `It resets on ${fmtReset(reset)}.${tail}`;
    }
  }
  return null;
}

/** Count one upstream Serper request (call right before sending it). */
export function recordSerperRequest(tenantId: string, cls: TenantClass, keySource: KeySource): void {
  if (!enabled) return;
  bump(tenantId, cls, 'serper', keySource);
  const s = current();
  for (const name of Object.keys(BUDGETS) as BudgetName[]) {
    if (BUDGETS[name].source !== keySource) continue;
    const v = budgetView(name);
    if (!v.warn) continue;
    const id = `${name}:${BUDGETS[name].period === 'day' ? dayKey() : s.month}`;
    if (s.warned.includes(id)) continue;
    s.warned.push(id);
    logger.warn('[usage] Serper budget at or above 80 %', { budget: name, used: v.used, limit: v.limit, pct: v.pct, resetsAt: v.resetsAt });
  }
}

// ---- report --------------------------------------------------------------------

export interface TenantInfo { displayName: string; class: TenantClass }

export interface UsageReport {
  generatedAt: string;
  timezone: 'UTC';
  days: Array<{
    date: string;
    calls: Record<TenantClass, number>;
    serper: Record<KeySource, number>;
    errors: Record<TenantClass, number>;
  }>;
  budgets: Record<BudgetName, { used: number; limit: number; pct: number; warn: boolean; resetsAt: string }>;
  caps: { publicMonthlyPerKey: number; internalMonthlyPerKey: number };
  month: string;
  tenants: Array<{ id: string; displayName: string | null; class: TenantClass; calls: number; serper: number; errors: number }>;
}

/**
 * The /v1/admin/usage body (without serperBalance, which the route adds). Days
 * are newest first, one entry per day for the last `days` UTC days (zeros when
 * idle). `tenantInfo` maps known tenant ids to their name and class; ids with
 * activity but no record (revoked, OAuth) show displayName null.
 */
export function usageReport(days: number, tenantInfo: Record<string, TenantInfo>): UsageReport {
  const n = Math.max(1, Math.min(Math.floor(days) || 7, 400));
  const s = current();
  const months = new Map<string, MonthFile | null>([[s.month, s]]);
  const out: UsageReport['days'] = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const mk = monthKey(d);
    if (!months.has(mk)) months.set(mk, readMonth(mk));
    const b = months.get(mk)?.days[dayKey(d)] || emptyDay();
    out.push({ date: dayKey(d), calls: { ...b.calls }, serper: { ...b.serper }, errors: { ...b.errors } });
  }
  const ids = new Set<string>([...Object.keys(tenantInfo), ...Object.keys(s.tenants)]);
  const tenants = [...ids].map((id) => {
    const m = s.tenants[id];
    const info = tenantInfo[id];
    return {
      id,
      displayName: info ? info.displayName : null,
      class: info ? info.class : (m?.class || 'public'),
      calls: m?.calls || 0,
      serper: m?.serper || 0,
      errors: m?.errors || 0,
    };
  }).sort((a, b) => b.serper - a.serper || b.calls - a.calls || a.id.localeCompare(b.id));
  return {
    generatedAt: new Date().toISOString(),
    timezone: 'UTC',
    days: out,
    budgets: {
      ownDaily: budgetView('ownDaily'),
      ownMonthly: budgetView('ownMonthly'),
      internalDaily: budgetView('internalDaily'),
      internalMonthly: budgetView('internalMonthly'),
    },
    caps: { publicMonthlyPerKey: limit('PUBLIC_MONTHLY_SERPER_CAP'), internalMonthlyPerKey: limit('INTERNAL_MONTHLY_SERPER_CAP') },
    month: s.month,
    tenants,
  };
}

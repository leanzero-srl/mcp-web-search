/**
 * Per-key document root for the HOSTED (HTTP) transport.
 *
 * Every hosted API key ("tenant") gets a private workspace,
 *   <DATA_DIR or cwd>/workspaces/<tenantId>/
 * and everything this server writes, reads or lists on that key's behalf — the
 * research-output markdown files AND the OpenAPI / crawl cache — is rooted
 * there. Before 2026-10-10 all demo keys shared one research-output directory
 * and one crawl cache, so any key could read, overwrite (via `appendToExisting`
 * + a chosen `filenamePrefix`) or even escape (via `filenamePrefix: "../.."`)
 * every other key's files. This module is the single source of truth for "which
 * directory does this request's files live under", mirroring the per-tenant
 * workspace shipped on mcp-doc-processor (src/utils/workspace.js).
 *
 * The stdio transport never sets a workspace, so getDocRoot() falls back to the
 * operator's configured output dir / cwd exactly as before — stdio behaviour is
 * unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getTenantWorkspace } from './request-context.js';

/** Directory that holds one sub-directory per hosted key. */
export function getWorkspacesBase(): string {
  return path.join(process.env.DATA_DIR || process.cwd(), 'workspaces');
}

const SAFE_ID = /^[A-Za-z0-9_:-]{1,128}$/;

/**
 * The folder name for a tenant's workspace. Server-minted UUIDs are used as-is.
 * Any other id (an OAuth `sub` such as "oauth:auth0|123") is mapped to a stable
 * hash, so it can never contain a path separator — and, unlike before, such a
 * key still GETS a workspace instead of running unconfined.
 */
export function workspaceDirName(tenantId: string): string {
  const id = String(tenantId || '');
  if (!id) throw new Error('invalid tenant id for workspace');
  if (SAFE_ID.test(id)) return id;
  return `h-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 40)}`;
}

/** Create (if needed) and return the real path of a tenant's workspace. */
export function workspaceForTenant(tenantId: string): string {
  const dir = path.join(getWorkspacesBase(), workspaceDirName(tenantId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return fs.realpathSync(dir);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where revoked keys' workspaces wait out their retention before deletion. */
export function getRevokedWorkspacesBase(): string {
  return path.join(process.env.DATA_DIR || process.cwd(), 'revoked-workspaces');
}

/** Retention for a revoked key's files (REVOKED_WORKSPACE_RETENTION_DAYS, default 7; 0 = delete at once). */
export function revokedRetentionMs(): number {
  const days = Number(process.env.REVOKED_WORKSPACE_RETENTION_DAYS);
  return (Number.isFinite(days) && days >= 0 ? days : 7) * DAY_MS;
}

/**
 * Delete archived workspaces whose retention has run out. The revocation time
 * is in the folder name (<dir>--<epochMs>) because a rename does not touch the
 * folder's mtime. Never throws; returns the names it removed.
 */
export function purgeExpiredRevokedWorkspaces(now: number = Date.now()): string[] {
  const base = getRevokedWorkspacesBase();
  const removed: string[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(base);
  } catch {
    return removed;
  }
  for (const name of entries) {
    const m = /--(\d{13})$/.exec(name);
    if (!m || now - Number(m[1]) < revokedRetentionMs()) continue;
    try {
      fs.rmSync(path.join(base, name), { recursive: true, force: true });
      removed.push(name);
    } catch { /* retried on the next sweep */ }
  }
  return removed;
}

/**
 * Take a revoked key's workspace out of service: move it to
 * <DATA_DIR>/revoked-workspaces/<dir>--<epochMs> (kept for the retention period,
 * then deleted by purgeExpiredRevokedWorkspaces). Returns the archive path, or
 * null when the key never had a workspace.
 */
export function archiveTenantWorkspace(tenantId: string, now: number = Date.now()): string | null {
  const name = workspaceDirName(tenantId);
  const src = path.join(getWorkspacesBase(), name);
  let archived: string | null = null;
  if (fs.existsSync(src)) {
    const base = getRevokedWorkspacesBase();
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    archived = path.join(base, `${name}--${now}`);
    fs.renameSync(src, archived);
  }
  purgeExpiredRevokedWorkspaces(now);
  return archived;
}

/** Per-key disk cap in bytes (WORKSPACE_QUOTA_MB, default 100). */
export function workspaceQuotaBytes(): number {
  const mb = Number(process.env.WORKSPACE_QUOTA_MB);
  return Math.floor((Number.isFinite(mb) && mb > 0 ? mb : 100) * 1024 * 1024);
}

/** Total bytes of the regular files under `dir` (symlinks are not followed). */
export function directorySizeBytes(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try { total += fs.lstatSync(p).size; } catch { /* vanished */ }
      }
    }
  }
  return total;
}

/**
 * The base directory for this request's generated/cached files.
 *   - Hosted request with a workspace  -> that workspace (per-key isolation).
 *   - Operator/self-host env override   -> OUTPUT_DIR / DOC_OUTPUT_DIR.
 *   - Default (stdio)                   -> launch dir if it's a project, else
 *                                          the repo root.
 * Mirrors the precedence getOutputRoot() used before, minus the X-Output-Dir
 * sub-folder (which server.ts still layers on top for research files only).
 */
export function getDocRoot(): string {
  const ws = getTenantWorkspace();
  if (ws) return ws;

  const override = process.env.OUTPUT_DIR || process.env.DOC_OUTPUT_DIR;
  if (override && override.trim()) {
    return path.isAbsolute(override) ? override : path.resolve(process.cwd(), override);
  }

  const isCwdProjectRoot = fs.existsSync(path.join(process.cwd(), 'package.json'));
  // __dirname is available in the CJS bundle (dist/bundle.cjs) and under vitest
  // (src/); the repo is ONE level up from either. It was '..', '..' = the repo's
  // PARENT, which is how stdio research reports landed in mcp-web-search-upd/docs
  // (2026-10-10). The ESM build has no __dirname and uses the cwd.
  const repoRoot = typeof __dirname !== 'undefined' ? path.resolve(__dirname, '..') : process.cwd();
  return isCwdProjectRoot ? process.cwd() : repoRoot;
}

/**
 * Reduce a caller-supplied filename fragment to a safe single path segment:
 * strip any directory part and refuse "~", so a value like "../../etc/evil" or
 * "~/secret" can never steer a write outside the intended directory. Returns ''
 * when nothing safe remains (the caller then uses its default).
 */
export function confineBasename(name: string | undefined): string {
  if (!name || typeof name !== 'string') return '';
  // Take the last path segment on either separator, drop NUL and leading dots
  // that could form "..", and keep it to filename-safe characters.
  const base = name.replace(/\0/g, '').split(/[\\/]+/).pop() || '';
  if (base === '' || base === '.' || base === '..' || base.startsWith('~')) return '';
  return base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+/, '').slice(0, 80);
}

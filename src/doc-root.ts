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
import { getTenantWorkspace } from './request-context.js';

/** Directory that holds one sub-directory per hosted key. */
export function getWorkspacesBase(): string {
  return path.join(process.env.DATA_DIR || process.cwd(), 'workspaces');
}

/**
 * Create (if needed) and return the real path of a tenant's workspace. The
 * tenant id is a server-minted UUID; validate defensively anyway so it can
 * never contain a path separator.
 */
export function workspaceForTenant(tenantId: string): string {
  if (!/^[A-Za-z0-9_:-]{1,128}$/.test(String(tenantId || ''))) {
    throw new Error('invalid tenant id for workspace');
  }
  const dir = path.join(getWorkspacesBase(), tenantId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return fs.realpathSync(dir);
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
  // __dirname is available in the CJS bundle the service actually runs; fall
  // back to cwd in the ESM/source path where it is not.
  const repoRoot = typeof __dirname !== 'undefined' ? path.resolve(__dirname, '..', '..') : process.cwd();
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

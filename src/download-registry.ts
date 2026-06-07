/**
 * Signed, time-limited download links for files created on a HOSTED server.
 *
 * TypeScript port of mcp-doc-processor's `src/utils/download-registry.js`. The
 * proper way a remote MCP delivers a generated file to the caller's machine: the
 * server keeps the bytes and returns a short-lived signed URL. A human in a chat
 * UI clicks it; an agent GETs it. No client filesystem access required.
 *
 * Stateless HMAC tokens (no server store): token = base64url(JSON{p,exp}).sig,
 * where sig = HMAC-SHA256(secret, payload). We only ever sign files we created,
 * and verification re-checks the signature, the expiry, and that the resolved
 * path is under an allowed base — so a token can't be forged or point elsewhere.
 *
 * Only active when a public base URL is known (FILE_DOWNLOAD_BASE or PUBLIC_HOST,
 * i.e. the hosted HTTP server). On stdio/self-host it returns null — files are
 * already on the caller's machine, so no link is needed.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

const TTL_MS = Number(process.env.FILE_DOWNLOAD_TTL_MS || 24 * 3600 * 1000);

let _ephemeralSecret: string | undefined;
function secret(): string {
  return (
    process.env.FILE_TOKEN_SECRET ||
    process.env.PROVISION_SECRET ||
    // web-search's admin var (doc-processor uses DOC_PROCESSOR_ADMIN_TOKEN here).
    process.env.MCP_WEB_SEARCH_ADMIN_TOKEN ||
    (_ephemeralSecret ??= crypto.randomBytes(32).toString('hex'))
  );
}

function downloadBase(): string | null {
  if (process.env.FILE_DOWNLOAD_BASE) return process.env.FILE_DOWNLOAD_BASE.replace(/\/+$/, '');
  if (process.env.PUBLIC_HOST) return `https://${process.env.PUBLIC_HOST}`;
  return null;
}

// Files may only be served from under these roots (defense in depth). WIDER than
// the doc-processor template on purpose: research markdown lands under
// getOutputRoot() (≈ process.cwd()), while OpenAPI specs land under the
// crawl-cache root — which, in this ESM build where __dirname is unavailable,
// can resolve to the launch dir's PARENT (e.g. <repo>/.. /docs/technical/openapi).
// Including cwd + its parent + the explicit output/cache env dirs covers both
// observed locations without leaking outside the project tree. Combined with the
// HMAC signature (paths can't be forged), this is defense-in-depth, not the
// primary control.
function allowedBases(): string[] {
  const bases = new Set<string>();
  const add = (p?: string | null): void => {
    if (p && String(p).trim()) bases.add(path.resolve(String(p)));
  };
  add(process.cwd());
  add(path.resolve(process.cwd(), '..'));
  add(process.env.DATA_DIR);
  if (process.env.DATA_DIR) add(path.join(process.env.DATA_DIR, 'client-output')); // default CLIENT_OUTPUT_BASE
  add(process.env.CLIENT_OUTPUT_BASE);
  add(process.env.OUTPUT_DIR);
  add(process.env.DOC_OUTPUT_DIR);
  add(process.env.CRAWL_CACHE_DIR);
  return [...bases];
}

function sign(b64: string): string {
  return crypto.createHmac('sha256', secret()).update(b64).digest('base64url');
}

/**
 * Build a signed download URL for a just-written file.
 * Returns null when no public base is configured (stdio — file is already local).
 */
export function buildDownloadUrl(filePath: string): string | null {
  const base = downloadBase();
  if (!base || !filePath) return null;
  const payload = { p: path.resolve(filePath), exp: Date.now() + TTL_MS };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const token = `${b64}.${sign(b64)}`;
  return `${base}/files/download?token=${encodeURIComponent(token)}`;
}

/** Verify a download token and return the file path to serve, or null. */
export function verifyDownloadToken(token: string): { path: string } | null {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(b64);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let payload: { p?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
  } catch {
    return null;
  }
  if (typeof payload.p !== 'string' || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  const resolved = path.resolve(payload.p);
  // Tighter than the JS template's bare startsWith: exact match OR child path,
  // so an allowed base "/a/b" can't be satisfied by a sibling "/a/bc".
  if (!allowedBases().some((b) => resolved === b || resolved.startsWith(b + path.sep))) return null;
  if (!fs.existsSync(resolved)) return null;
  return { path: resolved };
}

/** Best-effort MIME from extension, for the resource_link content block. */
export function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.md':
      return 'text/markdown';
    case '.json':
      return 'application/json';
    case '.yaml':
    case '.yml':
      return 'application/yaml';
    case '.txt':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}

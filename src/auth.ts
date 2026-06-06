/**
 * Tenant Bearer auth + admin surface for the HTTP transport.
 *
 * Mirrors the pattern shipped on the parallel `mcp-doc-processor` repo so the
 * two servers behave identically from a CogniRunner / operator perspective.
 * Notable adaptations for web-search:
 *   - admin token env var is `MCP_WEB_SEARCH_ADMIN_TOKEN`
 *   - default per-tenant rate limit is 20 req/min (vs doc-processor's 60)
 *     because each call hits external search APIs + the browser pool
 *
 * Tenants are stored under `${DATA_DIR}/tenants.json`, mode 0600, with bearers
 * hashed via argon2id. Rotation keeps the previous hash live for a 5 min grace
 * window so a swap doesn't break in-flight callers.
 */

import { promises as fs } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import argon2 from 'argon2';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { logger } from './logger.js';
import { verifyOAuth, oauthEnabled, protectedResourceMetadataUrl } from './oauth.js';

const DATA_DIR = process.env.DATA_DIR || process.cwd();
const TENANTS_PATH = path.join(DATA_DIR, 'tenants.json');
const ROTATE_GRACE_MS = 5 * 60 * 1000;

interface ExpiringHash {
  hash: string;
  expiresAt: number;
}

interface TenantRecord {
  displayName: string;
  bearerHash: string;
  expiringHashes: ExpiringHash[];
  createdAt: string;
  lastUsedAt: string | null;
  rotatedAt?: string;
}

type TenantMap = Record<string, TenantRecord>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: { id: string; displayName: string };
    }
  }
}

let cache: TenantMap | null = null;

async function loadTenants(): Promise<TenantMap> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(TENANTS_PATH, 'utf8');
    cache = JSON.parse(raw) as TenantMap;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      cache = {};
    } else {
      throw err;
    }
  }
  return cache;
}

async function saveTenants(tenants: TenantMap): Promise<void> {
  await fs.mkdir(path.dirname(TENANTS_PATH), { recursive: true });
  const tmp = `${TENANTS_PATH}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(tenants, null, 2), { mode: 0o600 });
  await fs.rename(tmp, TENANTS_PATH);
  try {
    await fs.chmod(TENANTS_PATH, 0o600);
  } catch {
    // best-effort on non-POSIX filesystems
  }
  cache = tenants;
}

export function invalidateTenantsCache(): void {
  cache = null;
}

function activeHashes(record: TenantRecord): string[] {
  const now = Date.now();
  const hashes: string[] = [];
  if (record.bearerHash) hashes.push(record.bearerHash);
  if (Array.isArray(record.expiringHashes)) {
    for (const e of record.expiringHashes) {
      if (e?.hash && typeof e.expiresAt === 'number' && now <= e.expiresAt) {
        hashes.push(e.hash);
      }
    }
  }
  return hashes;
}

/** Match a presented token against the stored argon2id tenant bearers. */
async function matchStaticBearer(token: string): Promise<{ id: string; displayName: string } | null> {
  const tenants = await loadTenants();
  for (const [tenantId, record] of Object.entries(tenants)) {
    for (const h of activeHashes(record)) {
      try {
        if (await argon2.verify(h, token)) {
          return { id: tenantId, displayName: record.displayName };
        }
      } catch {
        // malformed hash — skip
      }
    }
  }
  return null;
}

/** Emit a 401. When OAuth is enabled, include the RFC 9728 discovery hint that
 *  tells clients (e.g. claude.ai web) where to start the OAuth flow. */
function unauthorized(res: Response): void {
  if (oauthEnabled()) {
    const url = protectedResourceMetadataUrl();
    if (url) res.set('WWW-Authenticate', `Bearer resource_metadata="${url}"`);
  }
  res.status(401).json({ error: 'unauthorized' });
}

/**
 * Dual auth for `/mcp`: accept either an IdP-issued OAuth 2.1 access token
 * (claude.ai web / OAuth clients) OR a static argon2id tenant bearer (Claude API
 * connector, Cursor, Forge). On failure, challenge with WWW-Authenticate so
 * OAuth-capable clients can discover the authorization server.
 */
export const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const auth = req.headers.authorization;
  if (!auth || !/^Bearer\s+/i.test(auth)) {
    unauthorized(res);
    return;
  }
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    unauthorized(res);
    return;
  }

  // 1) OAuth access token (JWT validated against the IdP JWKS).
  const claims = await verifyOAuth(token);
  if (claims) {
    const sub = typeof claims.sub === 'string' ? claims.sub : 'oauth';
    req.tenant = { id: `oauth:${sub}`, displayName: (claims.email as string) || sub };
    return next();
  }

  // 2) Static tenant bearer.
  try {
    const tenant = await matchStaticBearer(token);
    if (tenant) {
      req.tenant = tenant;
      return next();
    }
  } catch (err) {
    logger.error('[auth] tenant load failed', { error: (err as Error).message });
    res.status(500).json({ error: 'internal error' });
    return;
  }

  unauthorized(res);
};

/** Back-compat: static-bearer-only guard (no OAuth path). */
export const requireBearer = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const auth = req.headers.authorization;
  if (!auth || !/^Bearer\s+/i.test(auth)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const tenant = await matchStaticBearer(token);
    if (tenant) {
      req.tenant = tenant;
      return next();
    }
  } catch (err) {
    logger.error('[auth] tenant load failed', { error: (err as Error).message });
    res.status(500).json({ error: 'internal error' });
    return;
  }
  res.status(401).json({ error: 'unauthorized' });
};

export const tenantRateLimiter = rateLimit({
  windowMs: 60_000,
  max: () => Number(process.env.TENANT_RATE_LIMIT) || 20,
  keyGenerator: (req: Request) => req.tenant?.id || req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    logger.warn('[auth] rate limit hit', { tenant: req.tenant?.id });
    res.status(429).json({ error: 'rate_limit_exceeded' });
  },
});

/**
 * Restrict the admin surface to genuine local processes only. Funnel proxies
 * from localhost too, so a loopback socket alone is not sufficient — we also
 * reject anything carrying `X-Forwarded-For` (which Tailscale Funnel/serve and
 * any reverse proxy add). Net effect: `/v1/admin/*` is reachable only from a
 * process on this machine, never over the public Funnel or the tailnet/LAN.
 * `ADMIN_ALLOW_REMOTE=1` opts out (e.g. if you later front it with your own
 * authenticated proxy).
 */
function localhostOnly(req: Request, res: Response, next: NextFunction): void {
  if (process.env.ADMIN_ALLOW_REMOTE === '1') return next();
  const ra = req.socket.remoteAddress || '';
  const isLoopback = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
  const forwarded = req.headers['x-forwarded-for'];
  if (isLoopback && !forwarded) return next();
  logger.warn('[admin] rejected non-local admin request', { remote: ra, forwarded: forwarded || null });
  res.status(403).json({ error: 'admin endpoints are localhost-only' });
}

function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.MCP_WEB_SEARCH_ADMIN_TOKEN;
  if (!expected) {
    res.status(503).json({ error: 'admin disabled (set MCP_WEB_SEARCH_ADMIN_TOKEN)' });
    return;
  }
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${expected}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

function generateBearer(): string {
  return randomBytes(32).toString('base64url');
}

export function mountAdminRoutes(app: Express): void {
  const router = express.Router();
  router.use(localhostOnly);
  router.use(express.json({ limit: '16kb' }));

  router.post('/tenants', adminAuth, async (req: Request, res: Response) => {
    const displayName = (req.body?.displayName || '').trim();
    if (!displayName) {
      res.status(400).json({ error: 'displayName required' });
      return;
    }

    const tenants = await loadTenants();
    const tenantId = randomUUID();
    const bearer = generateBearer();
    const bearerHash = await argon2.hash(bearer, { type: argon2.argon2id });

    tenants[tenantId] = {
      displayName,
      bearerHash,
      expiringHashes: [],
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    await saveTenants(tenants);
    logger.info('[admin] minted tenant', { tenantId, displayName });
    res.status(201).json({ tenantId, bearer, displayName });
  });

  router.get('/tenants', adminAuth, async (_req: Request, res: Response) => {
    const tenants = await loadTenants();
    const list = Object.entries(tenants).map(([id, r]) => ({
      tenantId: id,
      displayName: r.displayName,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      activeHashCount: activeHashes(r).length,
    }));
    res.json({ tenants: list });
  });

  router.delete('/tenants/:id', adminAuth, async (req: Request, res: Response) => {
    const tenants = await loadTenants();
    if (!tenants[req.params.id]) {
      res.status(404).json({ error: 'tenant not found' });
      return;
    }
    delete tenants[req.params.id];
    await saveTenants(tenants);
    logger.info('[admin] revoked tenant', { tenantId: req.params.id });
    res.json({ revoked: req.params.id });
  });

  router.post('/tenants/:id/rotate', adminAuth, async (req: Request, res: Response) => {
    const tenants = await loadTenants();
    const record = tenants[req.params.id];
    if (!record) {
      res.status(404).json({ error: 'tenant not found' });
      return;
    }

    const newBearer = generateBearer();
    const newHash = await argon2.hash(newBearer, { type: argon2.argon2id });

    const expiresAt = Date.now() + ROTATE_GRACE_MS;
    const expiring = Array.isArray(record.expiringHashes) ? record.expiringHashes : [];
    if (record.bearerHash) {
      expiring.push({ hash: record.bearerHash, expiresAt });
    }

    record.bearerHash = newHash;
    record.expiringHashes = expiring.filter((e) => Date.now() <= e.expiresAt);
    record.rotatedAt = new Date().toISOString();
    await saveTenants(tenants);

    logger.info('[admin] rotated tenant', { tenantId: req.params.id, graceMs: ROTATE_GRACE_MS });
    res.json({
      tenantId: req.params.id,
      bearer: newBearer,
      oldBearerExpiresAt: new Date(expiresAt).toISOString(),
    });
  });

  app.use('/v1/admin', router);
}

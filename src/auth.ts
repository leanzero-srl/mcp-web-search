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
    const tenants = await loadTenants();
    for (const [tenantId, record] of Object.entries(tenants)) {
      for (const h of activeHashes(record)) {
        try {
          if (await argon2.verify(h, token)) {
            req.tenant = { id: tenantId, displayName: record.displayName };
            return next();
          }
        } catch {
          // malformed hash — skip
        }
      }
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

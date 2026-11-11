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

import { promises as fs, realpathSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import argon2 from 'argon2';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { logger } from './logger.js';
import { verifyOAuth, oauthEnabled, protectedResourceMetadataUrl } from './oauth.js';
import { archiveTenantWorkspace, getWorkspacesBase, workspaceDirName } from './doc-root.js';
import { forgetCrawlCacheForRoot } from './crawl-cache.js';
import { usageReport, type TenantClass, type TenantInfo } from './usage-meter.js';
import { getSerperBalance } from './serper-policy.js';

const DATA_DIR = process.env.DATA_DIR || process.cwd();
const TENANTS_PATH = path.join(DATA_DIR, 'tenants.json');
const ROTATE_GRACE_MS = 5 * 60 * 1000;

interface ExpiringHash {
  hash: string;
  expiresAt: number;
}

interface TenantRecord {
  displayName: string;
  /** 'public' (default when absent: every key minted before 2026-11-11 and
   *  every /v1/provision key) or 'internal' (admin-minted, tailnet-only,
   *  searches on the server-side Serper key). */
  class?: TenantClass;
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
      tenant?: { id: string; displayName: string; class: TenantClass };
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

// Writes are serialised. Two overlapping saves used to share one tmp file
// name, so one rename hit ENOENT (the request then hung with no response), and
// a stale snapshot could land last: a lastUsedAt write that serialised the map
// before a revoke and renamed after it put the revoked key back on disk.
// Each queued write serialises the map when its turn comes, so the last write
// on disk is always the newest state.
let saveChain: Promise<void> = Promise.resolve();

async function writeTenantsFile(tenants: TenantMap): Promise<void> {
  await fs.mkdir(path.dirname(TENANTS_PATH), { recursive: true });
  const tmp = `${TENANTS_PATH}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, JSON.stringify(tenants, null, 2), { mode: 0o600 });
  await fs.rename(tmp, TENANTS_PATH);
  try {
    await fs.chmod(TENANTS_PATH, 0o600);
  } catch {
    // best-effort on non-POSIX filesystems
  }
}

async function saveTenants(tenants: TenantMap): Promise<void> {
  cache = tenants;
  const run = saveChain.then(() => writeTenantsFile(tenants));
  saveChain = run.catch(() => { /* the caller sees the error; the chain keeps going */ });
  await run;
}

export function invalidateTenantsCache(): void {
  cache = null;
}

// Throttle lastUsedAt writes so a burst of calls doesn't rewrite tenants.json
// on every request. Keyed by tenant id -> last-persisted epoch ms.
const LAST_USED_MIN_INTERVAL_MS = 60_000;
const lastUsedPersistedAt = new Map<string, number>();

/**
 * Record that a tenant's bearer was just used, at most once per minute per
 * tenant. Best-effort and non-blocking: a failure here must never fail the
 * request, and nothing sensitive (no token, no URL) is written — only an ISO
 * timestamp on the existing record. Mirrors mcp-doc-processor's lastUsedAt.
 */
export async function touchTenantLastUsed(tenantId: string): Promise<void> {
  try {
    const now = Date.now();
    const prev = lastUsedPersistedAt.get(tenantId) || 0;
    if (now - prev < LAST_USED_MIN_INTERVAL_MS) return;
    lastUsedPersistedAt.set(tenantId, now);
    const tenants = await loadTenants();
    const record = tenants[tenantId];
    if (!record) return;
    record.lastUsedAt = new Date(now).toISOString();
    await saveTenants(tenants);
  } catch {
    // best-effort audit metadata — never disrupt the request
  }
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
export function tenantClassOf(record: { class?: unknown } | undefined): TenantClass {
  return record?.class === 'internal' ? 'internal' : 'public';
}

async function matchStaticBearer(token: string): Promise<{ id: string; displayName: string; class: TenantClass } | null> {
  const tenants = await loadTenants();
  for (const [tenantId, record] of Object.entries(tenants)) {
    for (const h of activeHashes(record)) {
      try {
        if (await argon2.verify(h, token)) {
          return { id: tenantId, displayName: record.displayName, class: tenantClassOf(record) };
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
    req.tenant = { id: `oauth:${sub}`, displayName: (claims.email as string) || sub, class: 'public' };
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

/** Per-minute request limit for a tenant: public TENANT_RATE_LIMIT (20),
 *  internal INTERNAL_TENANT_RATE_LIMIT (120). Read per request. */
export function tenantRateLimitFor(cls: TenantClass | undefined): number {
  return cls === 'internal'
    ? Number(process.env.INTERNAL_TENANT_RATE_LIMIT) || 120
    : Number(process.env.TENANT_RATE_LIMIT) || 20;
}

export const tenantRateLimiter = rateLimit({
  windowMs: 60_000,
  max: (req: Request) => tenantRateLimitFor(req.tenant?.class),
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

export interface CreatedTenant { tenantId: string; bearer: string; displayName: string; class: TenantClass }

/** Mint a new tenant with a fresh random bearer (argon2id-hashed at rest). */
async function createTenant(displayName: string, cls: TenantClass = 'public'): Promise<CreatedTenant> {
  const tenants = await loadTenants();
  const tenantId = randomUUID();
  const bearer = generateBearer();
  const bearerHash = await argon2.hash(bearer, { type: argon2.argon2id });
  tenants[tenantId] = {
    displayName,
    class: cls,
    bearerHash,
    expiringHashes: [],
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  await saveTenants(tenants);
  return { tenantId, bearer, displayName, class: cls };
}

/**
 * Revoke a tenant by id. Returns false if it didn't exist. Its workspace is
 * moved out of service at once and deleted after the retention period
 * (doc-root.ts archiveTenantWorkspace); its memoised crawl cache is dropped.
 */
async function revokeTenant(tenantId: string): Promise<boolean> {
  const tenants = await loadTenants();
  if (!tenants[tenantId]) return false;
  delete tenants[tenantId];
  await saveTenants(tenants);
  try {
    try {
      forgetCrawlCacheForRoot(realpathSync(path.join(getWorkspacesBase(), workspaceDirName(tenantId))));
    } catch { /* never had a workspace */ }
    const archived = archiveTenantWorkspace(tenantId);
    logger.info('[auth] revoked key\'s workspace archived', { tenantId, archived: !!archived });
  } catch (err) {
    logger.warn('[auth] could not archive revoked key\'s workspace', { tenantId, error: (err as Error).message });
  }
  return true;
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
    const rawClass = req.body?.class ?? 'public';
    if (rawClass !== 'public' && rawClass !== 'internal') {
      res.status(400).json({ error: "class must be 'public' or 'internal'" });
      return;
    }
    const created = await createTenant(displayName, rawClass);
    logger.info('[admin] minted tenant', { tenantId: created.tenantId, displayName, class: created.class });
    res.status(201).json(created);
  });

  router.get('/tenants', adminAuth, async (_req: Request, res: Response) => {
    const tenants = await loadTenants();
    const list = Object.entries(tenants).map(([id, r]) => ({
      tenantId: id,
      displayName: r.displayName,
      class: tenantClassOf(r),
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      activeHashCount: activeHashes(r).length,
    }));
    res.json({ tenants: list });
  });

  // Usage and Serper spend (README "GET /v1/admin/usage"). Shape is stable: a
  // health/digest job builds against it. Never carries a key, hash or bearer.
  router.get('/usage', adminAuth, async (req: Request, res: Response) => {
    const days = Number(req.query.days) || 7;
    const tenants = await loadTenants();
    const info: Record<string, TenantInfo> = {};
    for (const [id, r] of Object.entries(tenants)) info[id] = { displayName: r.displayName, class: tenantClassOf(r) };
    const report = usageReport(days, info);
    const serperBalance = await getSerperBalance();
    res.json({ ...report, serperBalance });
  });

  router.delete('/tenants/:id', adminAuth, async (req: Request, res: Response) => {
    const ok = await revokeTenant(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'tenant not found' });
      return;
    }
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

/**
 * Gate for the self-service provisioning endpoint. Unlike `/v1/admin` (localhost
 * only, full power), `/v1/provision` is reachable over Funnel but guarded by a
 * shared secret (`PROVISION_SECRET`) known ONLY to a trusted backend — e.g. the
 * LeanZero website's server-side route, after it has authenticated its own user.
 * End users never see this secret or the admin token. Disabled until the secret
 * is set. Accepts the secret via `X-Provision-Secret` or `Authorization: Bearer`.
 */
function provisionAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.PROVISION_SECRET;
  if (!expected) {
    res.status(503).json({ error: 'provisioning disabled (set PROVISION_SECRET)' });
    return;
  }
  const presented = req.get('x-provision-secret')
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (presented !== expected) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

const provisionRateLimiter = rateLimit({
  windowMs: 60_000,
  max: () => Number(process.env.PROVISION_RATE_LIMIT) || 10,
  keyGenerator: (req: Request) => req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({ error: 'rate_limit_exceeded' });
  },
});

export function mountProvisionRoutes(app: Express): void {
  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));
  router.use(provisionAuth);
  router.use(provisionRateLimiter);

  // Mint a tenant bearer for one self-service user. `label` is a free-text tag
  // (e.g. the user's email) stored as the tenant displayName for the audit log.
  router.post('/', async (req: Request, res: Response) => {
    const label = String(req.body?.label || req.body?.displayName || 'self-service')
      .trim().slice(0, 120) || 'self-service';
    // Always public: a provisioned key must bring its own Serper key. The body's
    // `class` is ignored on purpose (internal keys are admin-only).
    const created = await createTenant(label, 'public');
    logger.info('[provision] minted tenant', { tenantId: created.tenantId, label });
    res.status(201).json(created);
  });

  // Revoke a previously-provisioned tenant by id.
  router.delete('/:id', async (req: Request, res: Response) => {
    const ok = await revokeTenant(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'tenant not found' });
      return;
    }
    logger.info('[provision] revoked tenant', { tenantId: req.params.id });
    res.json({ revoked: req.params.id });
  });

  app.use('/v1/provision', router);
}

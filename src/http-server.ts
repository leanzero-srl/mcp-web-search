#!/usr/bin/env node
/**
 * Streamable HTTP transport entry for `mcp-web-search`.
 *
 * Coexists with `index.ts` (stdio) — same 11 tools, different transport.
 * Per-request fresh `McpServer` (stateless mode) registered against the same
 * shared `WebSearchMCPServer` instance so the browser pool, search engine
 * rate limiter, and crawl cache stay process-shared.
 *
 * Design notes:
 *   - No stdio-safe console shim here. HTTP doesn't multiplex over stdout, so
 *     library log lines are harmless. Logs go to stderr via `logger`.
 *   - `compression()` middleware matters: web-search responses run 100KB-2MB
 *     of HTML extractions; gzip is a 4-6x bandwidth saving on Funnel egress.
 *   - DNS rebinding protection is enabled iff `PUBLIC_HOST` is set
 *     (CVE-2025-66414).
 *   - On SIGINT/SIGTERM the shared instance's `closeAll()` releases the
 *     browser pool before exit. The HTTP server itself constructs the shared
 *     instance with `skipShutdownHooks: true` so it owns the shutdown path.
 */

import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import compression from 'compression';
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebSearchMCPServer, WEB_SEARCH_INSTRUCTIONS } from './server.js';
import { attachClientDetect } from './client-detect.js';
import { requireAuth, tenantRateLimiter, mountAdminRoutes, mountProvisionRoutes, touchTenantLastUsed } from './auth.js';
import { mountOAuthMetadata } from './oauth.js';
import { requestContext } from './request-context.js';
import { workspaceForTenant, directorySizeBytes, workspaceQuotaBytes, purgeExpiredRevokedWorkspaces } from './doc-root.js';
import { verifyDownloadToken } from './download-registry.js';
import { logger } from './logger.js';
import { refusedLogger } from './refused-log.js';

const PORT = Number(process.env.PORT) || 8443;

/**
 * The tools that write files into a key's workspace. A key at its disk cap is
 * refused these. tests/integration/workspace-lifecycle.test.ts fails if a tool
 * is added without being classified here or in NO_FILE_WRITE_TOOLS.
 */
export const WRITE_TOOLS = new Set(['research_and_save_to_markdown', 'get-openapi-spec']);
export const NO_FILE_WRITE_TOOLS = new Set([
  'full-web-search', 'get-web-search-summaries', 'get-single-web-page-content', 'get-website-sitemap',
  'get-github-repo-content', 'progressive-web-search', 'get-pdf-content', 'list-cached-documents', 'read-cached-document',
]);
// Bind loopback only by default. Tailscale Funnel/serve proxies inbound traffic
// to 127.0.0.1:PORT, so loopback is sufficient — and it avoids colliding with
// tailscaled's own bind on the tailnet IPs (which would EADDRINUSE a wildcard
// bind after Funnel is enabled), while keeping the server off the tailnet/LAN.
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const PUBLIC_HOST = process.env.PUBLIC_HOST;
const SERVER_VERSION = '0.3.1';

export function buildApp(sharedInstance: WebSearchMCPServer): Express {
  const app = express();
  // Funnel terminates TLS upstream; req.ip needs the X-Forwarded-For chain.
  app.set('trust proxy', true);

  // Audit every refused request (401/403/404/405/429) before anything can answer.
  app.use(refusedLogger('web-search'));

  app.use(cors({
    origin: '*',
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'X-Serper-Key', 'X-GitHub-Token', 'X-Output-Dir', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
    exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
  }));

  // Tool inputs are small (URLs + queries). 4 MB is a generous ceiling.
  app.use(express.json({ limit: '4mb' }));
  app.use(compression());

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true, version: SERVER_VERSION, tools: 11 });
  });

  // Public signed-file download. The HMAC token IS the credential, so this route
  // is intentionally NOT behind requireAuth — it delivers files created by
  // research_and_save_to_markdown / get-openapi-spec to callers without a
  // sibling filesystem MCP. Tokens are ~24h, sandboxed to allowed bases; any
  // failure returns a uniform 403 (no information leak). Mirrors doc-processor's
  // GET /files/download.
  app.get('/files/download', (req: Request, res: Response) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const v = verifyDownloadToken(token);
    if (!v) {
      res.status(403).json({ error: 'invalid or expired token' });
      return;
    }
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(v.path).replace(/"/g, '')}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-store');
    fs.createReadStream(v.path)
      .on('error', () => {
        if (!res.headersSent) res.status(500).json({ error: 'read failed' });
      })
      .pipe(res);
  });

  mountAdminRoutes(app);
  mountProvisionRoutes(app);
  mountOAuthMetadata(app);

  const auditOnFinish = (req: Request, res: Response, started: number, toolName: string | undefined): void => {
    res.on('finish', () => {
      const ms = Date.now() - started;
      const result = res.statusCode >= 400 ? 'err' : 'ok';
      logger.info('mcp_call', {
        tenant: req.tenant?.id || null,
        tool: toolName || 'unknown',
        bytes_in: Number(req.headers['content-length']) || 0,
        ms,
        result,
        status: res.statusCode,
      });
    });
  };

  app.post('/mcp', requireAuth, tenantRateLimiter, async (req: Request, res: Response) => {
    const started = Date.now();
    const body = req.body as { method?: string; params?: { name?: string }; id?: string | number | null } | undefined;
    const toolName = body?.method === 'tools/call' ? body?.params?.name : body?.method;
    auditOnFinish(req, res, started, toolName);

    // Per-request keys, brought by each caller (never the operator's): the Serper
    // search key and an optional GitHub token for the github tool. Header for
    // header-capable clients, query param for Authorization-only clients (e.g.
    // claude.ai web). Never logged; carried via AsyncLocalStorage.
    const serperKey = req.get('x-serper-key') || (typeof req.query.serper_key === 'string' ? req.query.serper_key : undefined) || undefined;
    const githubToken = req.get('x-github-token') || (typeof req.query.github_token === 'string' ? req.query.github_token : undefined) || undefined;
    // Per-request output sub-dir (X-Output-Dir / ?output_dir). Sandboxed server-side
    // in getOutputRoot(); does NOT reach the caller's machine (self-host for that).
    const outputDir = req.get('x-output-dir') || (typeof req.query.output_dir === 'string' ? req.query.output_dir : undefined) || undefined;

    // Per-key workspace: every file this request writes/reads/lists (research
    // markdown, OpenAPI/crawl cache) is rooted here, so one demo key never sees
    // or overwrites another's. Keyed by the authenticated tenant id. Omitted
    // only if something upstream failed to set req.tenant (requireAuth would
    // already have 401'd), in which case we fall back to no workspace.
    const tenantId = req.tenant?.id;
    let workspace: string | undefined;
    if (tenantId) {
      try {
        workspace = workspaceForTenant(tenantId);
      } catch (err) {
        // Fail CLOSED: a hosted call without its workspace would fall back to the
        // operator's shared directories (stdio behaviour) — never run it.
        logger.error('[mcp] workspace setup failed', { tenant: tenantId, error: (err as Error).message });
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: body?.id ?? null });
        return;
      }
    }

    // Per-key disk cap: a key whose workspace is at or over WORKSPACE_QUOTA_MB
    // cannot run the tools that write files; everything else keeps working.
    if (workspace && toolName && WRITE_TOOLS.has(toolName)) {
      const cap = workspaceQuotaBytes();
      const used = directorySizeBytes(workspace);
      if (used >= cap) {
        const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
        logger.info('[mcp] workspace full', { tenant: tenantId, tool: toolName });
        res.status(200).json({
          jsonrpc: '2.0',
          id: body?.id ?? null,
          result: {
            isError: true,
            content: [{
              type: 'text',
              text: `Workspace full: this key's files use ${mb(used)} MB of its ${mb(cap)} MB limit, so "${toolName}" was not run. ` +
                'Searching, reading and listing still work. Ask the server operator to clear old files, or use a new key.',
            }],
          },
        });
        return;
      }
    }
    // Best-effort lastUsedAt (≤1/min), for the operator's audit of key activity.
    if (tenantId) void touchTenantLastUsed(tenantId);

    // Fresh McpServer per request (stateless transport requires it). The 11
    // tool handlers close over `sharedInstance.searchEngine` etc., so the
    // heavy state remains process-shared.
    const mcpServer = new McpServer({
      name: 'web-search-mcp',
      version: SERVER_VERSION,
    }, { instructions: WEB_SEARCH_INSTRUCTIONS });
    attachClientDetect(mcpServer);
    sharedInstance.registerToolsOn(mcpServer);

    const transportOpts: ConstructorParameters<typeof StreamableHTTPServerTransport>[0] = {
      sessionIdGenerator: undefined,
    };
    if (PUBLIC_HOST) {
      // Accept both `host:port` and bare `host`: Tailscale Funnel may or may not
      // forward the non-default port in the Host header, and a mismatch would 403
      // all traffic. `ALLOWED_HOSTS` (comma-separated) is an explicit override.
      const hosts = new Set<string>([PUBLIC_HOST]);
      const bareHost = PUBLIC_HOST.split(':')[0];
      if (bareHost) hosts.add(bareHost);
      if (process.env.ALLOWED_HOSTS) {
        for (const h of process.env.ALLOWED_HOSTS.split(',')) {
          const t = h.trim();
          if (t) hosts.add(t);
        }
      }
      transportOpts.enableDnsRebindingProtection = true;
      transportOpts.allowedHosts = [...hosts];
    }
    const transport = new StreamableHTTPServerTransport(transportOpts);

    res.on('close', () => {
      transport.close().catch(() => { /* best-effort cleanup */ });
    });

    try {
      await requestContext.run({ serperKey, githubToken, outputDir, tenantId, workspace }, async () => {
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
      });
    } catch (err) {
      logger.error('[mcp] handleRequest failed', { error: (err as Error).message });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'internal error' },
          id: body?.id ?? null,
        });
      }
    }
  });

  return app;
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  const sharedInstance = new WebSearchMCPServer({ skipShutdownHooks: true });
  const app = buildApp(sharedInstance);

  if (!PUBLIC_HOST) {
    logger.warn('[boot] PUBLIC_HOST not set — DNS rebinding protection disabled. Set PUBLIC_HOST before exposing this server publicly.');
  }

  const server = app.listen(PORT, BIND_HOST, () => {
    logger.info(`mcp-web-search HTTP listening on ${BIND_HOST}:${PORT}`);
  });

  // Revoked keys' archived workspaces are deleted once their retention ends
  // (also swept on every revoke).
  const sweep = (): void => {
    const removed = purgeExpiredRevokedWorkspaces();
    if (removed.length) logger.info('[boot] purged expired revoked workspaces', { count: removed.length });
  };
  sweep();
  setInterval(sweep, 6 * 60 * 60 * 1000).unref();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`[boot] ${signal} received, shutting down`);
    server.close();
    try {
      await sharedInstance.closeAll();
    } catch (err) {
      logger.error('[boot] shutdown error', { error: (err as Error).message });
    }
    process.exit(0);
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

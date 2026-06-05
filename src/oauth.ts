/**
 * OAuth 2.1 *resource server* surface for the HTTP transport.
 *
 * This server is NOT an authorization server. A managed IdP (Stytch / WorkOS /
 * Auth0 / Keycloak, with MCP Dynamic Client Registration) owns login, consent,
 * PKCE, DCR, and token issuance. Here we only:
 *   1. publish RFC 9728 Protected Resource Metadata so MCP clients (e.g.
 *      claude.ai web) can discover where to authenticate, and
 *   2. validate the IdP-issued JWT access tokens presented on `/mcp`.
 *
 * Config (all optional — when unset, OAuth is disabled and the server falls back
 * to static tenant bearers only):
 *   OAUTH_ISSUER    — the IdP issuer URL (the `iss` claim to require)
 *   OAUTH_JWKS_URL  — the IdP JWKS endpoint used to verify token signatures
 *   OAUTH_AUDIENCE  — the expected `aud` (our resource URL, e.g.
 *                     https://host.ts.net:8443/mcp)
 *   PUBLIC_HOST     — host[:port] clients use; builds the resource/metadata URLs
 */

import { type Express, type Request, type Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { logger } from './logger.js';

const OAUTH_ISSUER = process.env.OAUTH_ISSUER;
const OAUTH_JWKS_URL = process.env.OAUTH_JWKS_URL;
const OAUTH_AUDIENCE = process.env.OAUTH_AUDIENCE;
const PUBLIC_HOST = process.env.PUBLIC_HOST;

export function oauthEnabled(): boolean {
  return Boolean(OAUTH_ISSUER && OAUTH_JWKS_URL);
}

/** Absolute URL of the RFC 9728 metadata document, for the WWW-Authenticate hint. */
export function protectedResourceMetadataUrl(): string | undefined {
  if (!PUBLIC_HOST) return undefined;
  return `https://${PUBLIC_HOST}/.well-known/oauth-protected-resource`;
}

// createRemoteJWKSet caches keys and handles rotation/refresh internally.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks(): ReturnType<typeof createRemoteJWKSet> | null {
  if (!OAUTH_JWKS_URL) return null;
  if (!jwks) jwks = createRemoteJWKSet(new URL(OAUTH_JWKS_URL));
  return jwks;
}

/**
 * Validate an OAuth access token. Returns the verified claims on success, or
 * null when OAuth is disabled or the token is invalid/expired/wrong-audience.
 */
export async function verifyOAuth(token: string): Promise<JWTPayload | null> {
  const keys = getJwks();
  if (!keys || !OAUTH_ISSUER) return null;
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: OAUTH_ISSUER,
      ...(OAUTH_AUDIENCE ? { audience: OAUTH_AUDIENCE } : {}),
    });
    return payload;
  } catch (err) {
    logger.info('[oauth] token verification failed', { error: (err as Error).message });
    return null;
  }
}

/**
 * Mount GET /.well-known/oauth-protected-resource (RFC 9728). Only active when
 * OAuth is configured — otherwise we 404 so clients don't see misleading metadata.
 */
export function mountOAuthMetadata(app: Express): void {
  app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    if (!oauthEnabled() || !PUBLIC_HOST) {
      res.status(404).json({ error: 'oauth not configured' });
      return;
    }
    res.json({
      resource: OAUTH_AUDIENCE || `https://${PUBLIC_HOST}/mcp`,
      authorization_servers: [OAUTH_ISSUER],
      bearer_methods_supported: ['header'],
    });
  });
}

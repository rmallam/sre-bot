/**
 * Express middleware — OIDC JWT auth + namespace RBAC for console BFF.
 */

import type { Request, Response, NextFunction } from 'express';
import { fetchOidcDiscovery } from '../../../shared/src/oidc-discovery.js';
import {
  consoleAuthConfig,
  consoleAuthEnabled,
  verifyConsoleAccessToken,
  type ConsoleUser,
} from '../../../shared/src/console-auth.js';
import {
  createSession,
  destroySession,
  getSession,
  readSessionId,
  setSessionCookie,
  clearSessionCookie,
  updateSession,
  type ConsoleSession,
} from './session-store.js';

declare global {
  namespace Express {
    interface Request {
      consoleUser?: ConsoleUser;
    }
  }
}

const PUBLIC_PATHS = new Set([
  '/api/health',
  '/health',
  '/api/auth/config',
  '/api/auth/login',
  '/api/auth/callback',
  '/api/auth/logout',
]);

export function createConsoleAuthMiddleware() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!consoleAuthEnabled()) {
      req.consoleUser = {
        userId: 'console',
        groups: [],
        allowedNamespaces: ['*'],
      };
      next();
      return;
    }

    if (PUBLIC_PATHS.has(req.path) || !req.path.startsWith('/api/')) {
      next();
      return;
    }

    const sid = readSessionId(req);
    const session = await getSession(sid);
    if (!session) {
      res.status(401).json({ error: 'Authentication required', code: 'auth_required' });
      return;
    }

    try {
      req.consoleUser = await resolveSessionUser(session, sid);
      next();
    } catch (err) {
      await destroySession(sid);
      clearSessionCookie(res);
      const message = err instanceof Error ? err.message : String(err);
      res.status(401).json({ error: 'Invalid or expired session', detail: message });
    }
  };
}

export function getConsoleUser(req: Request): ConsoleUser {
  return (
    req.consoleUser ?? {
      userId: 'console',
      groups: [],
      allowedNamespaces: ['*'],
    }
  );
}

export function authConfigPayload() {
  const cfg = consoleAuthConfig();
  const redirectUri =
    process.env['OIDC_REDIRECT_URI'] ??
    process.env['CONSOLE_OIDC_REDIRECT_URI'] ??
    'http://localhost:8091/api/auth/callback';
  return {
    enabled: cfg.enabled,
    issuer: cfg.issuer,
    clientId: cfg.clientId,
    audience: cfg.audience,
    redirectUri,
    scopes: process.env['OIDC_SCOPES'] ?? 'openid profile email offline_access',
    sessionCookie: true,
    sessionBackend: process.env['CONSOLE_SESSION_BACKEND'] ?? 'memory',
  };
}

export interface OidcTokenPair {
  accessToken: string;
  refreshToken?: string;
}

async function tokenRequest(body: URLSearchParams): Promise<OidcTokenPair> {
  const cfg = consoleAuthConfig();
  if (!cfg.issuer || !cfg.clientId) {
    throw new Error('OIDC_ISSUER and OIDC_CLIENT_ID required');
  }
  const secret = process.env['OIDC_CLIENT_SECRET'];
  if (!secret) throw new Error('OIDC_CLIENT_SECRET required for token exchange');

  const discovery = await fetchOidcDiscovery(cfg.issuer);
  const res = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token exchange failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token?: string; refresh_token?: string };
  if (!data.access_token) throw new Error('Token response missing access_token');
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  };
}

async function resolveSessionUser(session: ConsoleSession, sid: string): Promise<ConsoleUser> {
  try {
    return await verifyConsoleAccessToken(session.accessToken);
  } catch (firstErr) {
    if (!session.refreshToken) throw firstErr;
    const tokens = await refreshOidcTokens(session.refreshToken);
    const user = await verifyConsoleAccessToken(tokens.accessToken);
    await updateSession(sid, {
      ...session,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? session.refreshToken,
      user,
      expiresAt: Date.now() + parseInt(process.env['CONSOLE_SESSION_TTL_SEC'] ?? String(8 * 3600), 10) * 1000,
    });
    return user;
  }
}

export async function exchangeOidcCode(code: string, redirectUri: string): Promise<OidcTokenPair> {
  const cfg = consoleAuthConfig();
  if (!cfg.clientId) throw new Error('OIDC_CLIENT_ID required for login callback');
  return tokenRequest(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: cfg.clientId,
      client_secret: process.env['OIDC_CLIENT_SECRET'] ?? '',
      code,
      redirect_uri: redirectUri,
    })
  );
}

export async function refreshOidcTokens(refreshToken: string): Promise<OidcTokenPair> {
  const cfg = consoleAuthConfig();
  if (!cfg.clientId) throw new Error('OIDC_CLIENT_ID required for token refresh');
  return tokenRequest(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cfg.clientId,
      client_secret: process.env['OIDC_CLIENT_SECRET'] ?? '',
      refresh_token: refreshToken,
    })
  );
}

export async function buildOidcLoginUrl(redirectUri: string): Promise<string> {
  const cfg = consoleAuthConfig();
  if (!cfg.issuer || !cfg.clientId) {
    throw new Error('OIDC_ISSUER and OIDC_CLIENT_ID required');
  }
  const discovery = await fetchOidcDiscovery(cfg.issuer);
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: process.env['OIDC_SCOPES'] ?? 'openid profile email offline_access',
  });
  return `${discovery.authorization_endpoint}?${params}`;
}

export async function establishSessionFromTokens(
  res: Response,
  tokens: OidcTokenPair
): Promise<ConsoleUser> {
  const user = await verifyConsoleAccessToken(tokens.accessToken);
  const sid = await createSession(tokens.accessToken, user, tokens.refreshToken);
  setSessionCookie(res, sid);
  return user;
}

export async function logoutSession(req: Request, res: Response): Promise<void> {
  await destroySession(readSessionId(req));
  clearSessionCookie(res);
}

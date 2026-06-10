/**
 * CON-2 — Console OIDC JWT validation + namespace RBAC helpers.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { fetchOidcDiscovery } from './oidc-discovery.js';
import {
  type ConsoleUser,
  resolveAllowedNamespaces,
  NamespaceAccessDeniedError,
} from './namespace-rbac.js';

export { type ConsoleUser, NamespaceAccessDeniedError } from './namespace-rbac.js';
export {
  canAccessNamespace,
  filterByNamespaceAccess,
  assertNamespaceAccess,
  hasGlobalNamespaceAccess,
  parseNamespaceRbacMap,
} from './namespace-rbac.js';

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksIssuer: string | undefined;

export function consoleAuthEnabled(): boolean {
  const raw = process.env['CONSOLE_AUTH_ENABLED'] ?? process.env['CONSOLE_OIDC_ENABLED'];
  if (raw == null || raw.trim() === '') return false;
  return raw.toLowerCase() === 'true' || raw === '1';
}

export function consoleAuthConfig(): {
  enabled: boolean;
  issuer?: string;
  clientId?: string;
  audience?: string;
  groupsClaim: string;
} {
  return {
    enabled: consoleAuthEnabled(),
    issuer: process.env['OIDC_ISSUER']?.replace(/\/$/, ''),
    clientId: process.env['OIDC_CLIENT_ID'],
    audience: process.env['OIDC_AUDIENCE'] ?? process.env['OIDC_CLIENT_ID'],
    groupsClaim: process.env['OIDC_GROUPS_CLAIM'] ?? 'groups',
  };
}

function extractGroups(payload: JWTPayload, groupsClaim: string): string[] {
  const raw = payload[groupsClaim];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') return raw.split(/[,;\s]+/).filter(Boolean);

  const realm = payload['realm_access'] as { roles?: string[] } | undefined;
  if (realm?.roles?.length) return realm.roles.map(String);

  const resourceAccess = payload['resource_access'] as Record<string, { roles?: string[] }> | undefined;
  if (resourceAccess) {
    const roles = new Set<string>();
    for (const entry of Object.values(resourceAccess)) {
      for (const r of entry.roles ?? []) roles.add(String(r));
    }
    if (roles.size) return [...roles];
  }
  return [];
}

async function getJwks(issuer: string): Promise<ReturnType<typeof createRemoteJWKSet>> {
  if (jwks && jwksIssuer === issuer) return jwks;
  const doc = await fetchOidcDiscovery(issuer);
  jwks = createRemoteJWKSet(new URL(doc.jwks_uri));
  jwksIssuer = issuer;
  return jwks;
}

export async function verifyConsoleAccessToken(token: string): Promise<ConsoleUser> {
  const cfg = consoleAuthConfig();
  if (!cfg.enabled) {
    return {
      userId: 'anonymous',
      groups: [],
      allowedNamespaces: ['*'],
    };
  }
  if (!cfg.issuer) throw new Error('OIDC_ISSUER required when CONSOLE_AUTH_ENABLED=true');

  const keys = await getJwks(cfg.issuer);
  const { payload } = await jwtVerify(token, keys, {
    issuer: cfg.issuer,
    audience: cfg.audience,
  });

  const userId = String(payload.sub ?? payload.preferred_username ?? 'unknown');
  const groups = extractGroups(payload, cfg.groupsClaim);
  const allowedNamespaces = resolveAllowedNamespaces(groups);

  return {
    userId,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    groups,
    allowedNamespaces,
  };
}

export function bearerTokenFromHeader(authHeader: string | undefined): string | undefined {
  if (!authHeader?.startsWith('Bearer ')) return undefined;
  const token = authHeader.slice('Bearer '.length).trim();
  return token || undefined;
}

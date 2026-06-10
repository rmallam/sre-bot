/**
 * OIDC discovery — provider-agnostic authorization/token/JWKS endpoints.
 */

export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const CACHE_TTL_MS = 3_600_000;
const cachedDocs = new Map<string, { doc: OidcDiscoveryDocument; fetchedAt: number }>();

function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/$/, '');
}

export function clearOidcDiscoveryCache(issuer?: string): void {
  if (issuer) {
    cachedDocs.delete(normalizeIssuer(issuer));
    return;
  }
  cachedDocs.clear();
}

export async function fetchOidcDiscovery(issuer: string): Promise<OidcDiscoveryDocument> {
  const normalized = normalizeIssuer(issuer);
  const hit = cachedDocs.get(normalized);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return hit.doc;
  }

  const discoveryUrl = `${normalized}/.well-known/openid-configuration`;
  const res = await fetch(discoveryUrl, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: ${res.status} (${discoveryUrl})`);
  }

  const raw = (await res.json()) as Partial<OidcDiscoveryDocument>;
  if (!raw.authorization_endpoint || !raw.token_endpoint || !raw.jwks_uri) {
    throw new Error('OIDC discovery missing authorization_endpoint, token_endpoint, or jwks_uri');
  }

  const doc: OidcDiscoveryDocument = {
    issuer: raw.issuer ? normalizeIssuer(raw.issuer) : normalized,
    authorization_endpoint: raw.authorization_endpoint,
    token_endpoint: raw.token_endpoint,
    jwks_uri: raw.jwks_uri,
  };

  cachedDocs.set(normalized, { doc, fetchedAt: Date.now() });
  return doc;
}

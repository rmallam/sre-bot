/**
 * Bearer token auth for inter-agent HTTP APIs.
 *
 * Set SRE_INTERNAL_TOKEN on all agents. Callers send Authorization: Bearer <token>.
 * SRE_AUTH_STRICT=true (default) enforces auth; set false for local docker-compose dev.
 */

import crypto from 'node:crypto';

export interface InternalAuthRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface InternalAuthResponse {
  status: (code: number) => { json: (body: unknown) => void };
}

export function isAuthStrict(): boolean {
  return (process.env['SRE_AUTH_STRICT'] ?? 'true').toLowerCase() === 'true';
}

export function internalToken(): string | undefined {
  const t = process.env['SRE_INTERNAL_TOKEN']?.trim();
  return t || undefined;
}

export function validateInternalBearer(authHeader: string | undefined): boolean {
  const token = internalToken();
  if (!token) return false;
  const raw = authHeader?.trim() ?? '';
  const bearer = raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw;
  if (!bearer) return false;
  try {
    const h1 = crypto.createHash('sha256').update(bearer).digest();
    const h2 = crypto.createHash('sha256').update(token).digest();
    return crypto.timingSafeEqual(h1, h2);
  } catch {
    return false;
  }
}

/** Headers for outbound agent-to-agent requests. */
export function internalAuthHeaders(
  extra?: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const token = internalToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

/** Merge internal auth into fetch init headers. */
export function withInternalAuth(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(internalAuthHeaders())) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return { ...init, headers };
}

export function createInternalAuthMiddleware(): (
  req: InternalAuthRequest,
  res: InternalAuthResponse,
  next: () => void
) => void {
  return (req, res, next): void => {
    if (!isAuthStrict()) {
      next();
      return;
    }
    if (req.method === 'GET' && (req.path === '/health' || req.path === '/')) {
      next();
      return;
    }
    const token = internalToken();
    if (!token) {
      res.status(503).json({
        error: 'SRE_INTERNAL_TOKEN is not configured (required when SRE_AUTH_STRICT=true)',
      });
      return;
    }
    const auth = req.headers['authorization'];
    const authHeader = Array.isArray(auth) ? auth[0] : auth;
    if (!validateInternalBearer(authHeader)) {
      res.status(401).json({ error: 'Unauthorized — Bearer token required' });
      return;
    }
    next();
  };
}

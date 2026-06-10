/**
 * Server-side console sessions — access tokens never exposed to browser JavaScript.
 * Backends: memory (default) or redis (CONSOLE_SESSION_BACKEND=redis + REDIS_URL).
 */

import { randomUUID } from 'node:crypto';
import type { ConsoleUser } from '../../../shared/src/console-auth.js';

const SESSION_COOKIE = 'sre_console_sid';
const DEFAULT_TTL_SEC = parseInt(process.env['CONSOLE_SESSION_TTL_SEC'] ?? String(8 * 3600), 10);
const SWEEP_MS = parseInt(process.env['CONSOLE_SESSION_SWEEP_MS'] ?? String(15 * 60 * 1000), 10);

export interface ConsoleSession {
  accessToken: string;
  refreshToken?: string;
  user: ConsoleUser;
  expiresAt: number;
}

interface SessionBackend {
  save(session: ConsoleSession, sid: string, ttlSec: number): Promise<void>;
  get(sid: string): Promise<ConsoleSession | undefined>;
  destroy(sid: string): Promise<void>;
  purgeExpired?(): Promise<void>;
}

const memorySessions = new Map<string, ConsoleSession>();

const memoryBackend: SessionBackend = {
  async save(session, sid) {
    memorySessions.set(sid, session);
  },
  async get(sid) {
    const session = memorySessions.get(sid);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      memorySessions.delete(sid);
      return undefined;
    }
    return session;
  },
  async destroy(sid) {
    memorySessions.delete(sid);
  },
  async purgeExpired() {
    const now = Date.now();
    for (const [sid, session] of memorySessions) {
      if (session.expiresAt <= now) memorySessions.delete(sid);
    }
  },
};

let backend: SessionBackend = memoryBackend;
let redisClient: import('ioredis').default | undefined;

async function redisBackend(): Promise<SessionBackend> {
  if (!redisClient) {
    const { default: Redis } = await import('ioredis');
    const url = process.env['REDIS_URL']?.trim();
    if (!url) throw new Error('REDIS_URL required when CONSOLE_SESSION_BACKEND=redis');
    redisClient = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
    await redisClient.connect();
  }
  const redis = redisClient;
  const prefix = process.env['CONSOLE_SESSION_REDIS_PREFIX'] ?? 'sre:console:session:';

  return {
    async save(session, sid, ttlSec) {
      await redis.setex(`${prefix}${sid}`, ttlSec, JSON.stringify(session));
    },
    async get(sid) {
      const raw = await redis.get(`${prefix}${sid}`);
      if (!raw) return undefined;
      try {
        const session = JSON.parse(raw) as ConsoleSession;
        if (session.expiresAt <= Date.now()) {
          await redis.del(`${prefix}${sid}`);
          return undefined;
        }
        return session;
      } catch {
        return undefined;
      }
    },
    async destroy(sid) {
      await redis.del(`${prefix}${sid}`);
    },
  };
}

function buildSession(
  accessToken: string,
  user: ConsoleUser,
  refreshToken?: string
): ConsoleSession {
  return {
    accessToken,
    refreshToken,
    user,
    expiresAt: Date.now() + sessionTtlSec() * 1000,
  };
}

export async function initSessionStore(): Promise<void> {
  const mode = (process.env['CONSOLE_SESSION_BACKEND'] ?? 'memory').toLowerCase();
  if (mode === 'redis') {
    backend = await redisBackend();
  } else {
    backend = memoryBackend;
  }

  if (SWEEP_MS > 0 && backend.purgeExpired) {
    setInterval(() => {
      void backend.purgeExpired?.();
    }, SWEEP_MS).unref();
  }
}

export function sessionCookieName(): string {
  return SESSION_COOKIE;
}

export function sessionTtlSec(): number {
  return Number.isFinite(DEFAULT_TTL_SEC) && DEFAULT_TTL_SEC > 0 ? DEFAULT_TTL_SEC : 8 * 3600;
}

export function cookieSecure(): boolean {
  const raw = process.env['CONSOLE_COOKIE_SECURE'];
  if (raw != null && raw.trim() !== '') {
    return raw.toLowerCase() === 'true' || raw === '1';
  }
  return process.env['NODE_ENV'] === 'production';
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header?.trim()) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}

export function readSessionId(req: { headers: { cookie?: string } }): string | undefined {
  const cookies = parseCookieHeader(req.headers.cookie);
  const sid = cookies[SESSION_COOKIE]?.trim();
  return sid || undefined;
}

export async function createSession(
  accessToken: string,
  user: ConsoleUser,
  refreshToken?: string
): Promise<string> {
  await backend.purgeExpired?.();
  const sid = randomUUID();
  await backend.save(buildSession(accessToken, user, refreshToken), sid, sessionTtlSec());
  return sid;
}

export async function updateSession(sid: string, session: ConsoleSession): Promise<void> {
  await backend.save(session, sid, sessionTtlSec());
}

export async function getSession(sid: string | undefined): Promise<ConsoleSession | undefined> {
  if (!sid) return undefined;
  return backend.get(sid);
}

export async function destroySession(sid: string | undefined): Promise<void> {
  if (sid) await backend.destroy(sid);
}

export function setSessionCookie(res: { setHeader: (n: string, v: string) => void }, sid: string): void {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(sid)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${sessionTtlSec()}`,
  ];
  if (cookieSecure()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res: { setHeader: (n: string, v: string) => void }): void {
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];
  if (cookieSecure()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

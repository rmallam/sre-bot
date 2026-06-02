/**
 * Session persistence — memory or Redis (CHAT_SESSION_BACKEND / REDIS_URL).
 */

import type { ChatSession } from './sessions.js';

export interface SessionKey {
  platform: string;
  channelId: string;
  userId: string;
}

export interface WebSessionSummary {
  channelId: string;
  sessionLabel?: string;
  preview?: string;
  updatedAt: string;
  messageCount: number;
}

export interface SessionStore {
  get(key: SessionKey): Promise<ChatSession | undefined>;
  set(key: SessionKey, session: ChatSession): Promise<void>;
  delete(key: SessionKey): Promise<void>;
  listWebSessions(userId: string): Promise<WebSessionSummary[]>;
  touchWebIndex(userId: string, channelId: string, updatedAt: string): Promise<void>;
  close(): Promise<void>;
}

const SESSION_PREFIX = 'sre:chat:session:';
const WEB_INDEX_PREFIX = 'sre:chat:index:web:';

function redisSessionKey(k: SessionKey): string {
  return `${SESSION_PREFIX}${k.platform}:${k.channelId}:${k.userId}`;
}

function redisWebIndexKey(userId: string): string {
  return `${WEB_INDEX_PREFIX}${userId}`;
}

export class MemorySessionStore implements SessionStore {
  private readonly data = new Map<string, ChatSession>();
  private readonly webIndex = new Map<string, Map<string, number>>();

  private mapKey(k: SessionKey): string {
    return `${k.platform}:${k.channelId}:${k.userId}`;
  }

  async get(key: SessionKey): Promise<ChatSession | undefined> {
    return this.data.get(this.mapKey(key));
  }

  async set(key: SessionKey, session: ChatSession): Promise<void> {
    this.data.set(this.mapKey(key), session);
    if (key.platform === 'web') {
      await this.touchWebIndex(key.userId, key.channelId, session.updatedAt);
    }
  }

  async delete(key: SessionKey): Promise<void> {
    this.data.delete(this.mapKey(key));
    if (key.platform === 'web') {
      this.webIndex.get(key.userId)?.delete(key.channelId);
    }
  }

  async touchWebIndex(userId: string, channelId: string, updatedAt: string): Promise<void> {
    let idx = this.webIndex.get(userId);
    if (!idx) {
      idx = new Map();
      this.webIndex.set(userId, idx);
    }
    idx.set(channelId, Date.parse(updatedAt) || Date.now());
  }

  async listWebSessions(userId: string): Promise<WebSessionSummary[]> {
    const idx = this.webIndex.get(userId);
    if (!idx) return [];
    const out: WebSessionSummary[] = [];
    for (const [channelId, score] of idx) {
      const session = await this.get({ platform: 'web', channelId, userId });
      if (!session) continue;
      out.push(sessionToSummary(channelId, session, score));
    }
    return out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async close(): Promise<void> {
    this.data.clear();
    this.webIndex.clear();
  }
}

export class RedisSessionStore implements SessionStore {
  private redis: import('ioredis').default | null = null;

  constructor(private readonly redisUrl: string) {}

  async connect(): Promise<void> {
    const { default: Redis } = await import('ioredis');
    this.redis = new Redis(this.redisUrl, { maxRetriesPerRequest: 2 });
    await this.redis.ping();
  }

  private client(): import('ioredis').default {
    if (!this.redis) throw new Error('Redis session store not connected');
    return this.redis;
  }

  async get(key: SessionKey): Promise<ChatSession | undefined> {
    const raw = await this.client().get(redisSessionKey(key));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as ChatSession;
    } catch {
      return undefined;
    }
  }

  async set(key: SessionKey, session: ChatSession): Promise<void> {
    const ttl = parseInt(process.env['CHAT_SESSION_TTL_SECONDS'] ?? '604800', 10);
    const rkey = redisSessionKey(key);
    await this.client().set(rkey, JSON.stringify(session), 'EX', ttl);
    if (key.platform === 'web') {
      await this.touchWebIndex(key.userId, key.channelId, session.updatedAt);
    }
  }

  async delete(key: SessionKey): Promise<void> {
    await this.client().del(redisSessionKey(key));
    if (key.platform === 'web') {
      await this.client().zrem(redisWebIndexKey(key.userId), key.channelId);
    }
  }

  async touchWebIndex(userId: string, channelId: string, updatedAt: string): Promise<void> {
    const score = Date.parse(updatedAt) || Date.now();
    const ttl = parseInt(process.env['CHAT_SESSION_TTL_SECONDS'] ?? '604800', 10);
    const idxKey = redisWebIndexKey(userId);
    await this.client().zadd(idxKey, score, channelId);
    await this.client().expire(idxKey, ttl);
  }

  async listWebSessions(userId: string): Promise<WebSessionSummary[]> {
    const ids = await this.client().zrevrange(redisWebIndexKey(userId), 0, 49);
    const out: WebSessionSummary[] = [];
    for (const channelId of ids) {
      const session = await this.get({ platform: 'web', channelId, userId });
      if (!session) {
        await this.client().zrem(redisWebIndexKey(userId), channelId);
        continue;
      }
      out.push(sessionToSummary(channelId, session));
    }
    return out;
  }

  async close(): Promise<void> {
    await this.redis?.quit();
    this.redis = null;
  }
}

function sessionToSummary(
  channelId: string,
  session: ChatSession,
  score?: number
): WebSessionSummary {
  const lastUser = [...(session.transcript ?? [])].reverse().find((t) => t.role === 'user');
  return {
    channelId,
    sessionLabel: session.sessionLabel,
    preview: session.preview ?? lastUser?.content.slice(0, 120),
    updatedAt: session.updatedAt || (score ? new Date(score).toISOString() : new Date().toISOString()),
    messageCount: session.transcript?.length ?? 0,
  };
}

let store: SessionStore = new MemorySessionStore();

export function getSessionStore(): SessionStore {
  return store;
}

export async function initSessionStore(): Promise<{ backend: 'memory' | 'redis' }> {
  const redisUrl = process.env['REDIS_URL'];
  const backend = (process.env['CHAT_SESSION_BACKEND'] ?? (redisUrl ? 'redis' : 'memory')).toLowerCase();

  if (backend === 'redis' && redisUrl) {
    try {
      const redisStore = new RedisSessionStore(redisUrl);
      await redisStore.connect();
      store = redisStore;
      return { backend: 'redis' };
    } catch (err) {
      const { log } = await import('../../../shared/src/http.js');
      log('warn', 'commander-session-store', 'Redis unavailable — using in-memory sessions', {
        error: String(err),
      });
    }
  }

  store = new MemorySessionStore();
  return { backend: 'memory' };
}

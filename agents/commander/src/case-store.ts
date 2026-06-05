/**
 * AGENT-1 — Case persistence (memory or Redis).
 */

import type { AgentCase } from '../../../shared/src/agent-case.js';
import { subjectDedupeKey } from '../../../shared/src/agent-case.js';

export interface CaseKey {
  platform: string;
  channelId: string;
  userId: string;
  caseId: string;
}

export interface CaseStore {
  get(key: CaseKey): Promise<AgentCase | undefined>;
  set(key: CaseKey, agentCase: AgentCase): Promise<void>;
  delete(key: CaseKey): Promise<void>;
  findOpenBySubject(
    platform: string,
    channelId: string,
    userId: string,
    subjectKey: string
  ): Promise<AgentCase | undefined>;
  setActiveCase(platform: string, channelId: string, userId: string, caseId: string): Promise<void>;
  getActiveCaseId(platform: string, channelId: string, userId: string): Promise<string | undefined>;
  close(): Promise<void>;
}

const CASE_PREFIX = 'sre:case:';
const ACTIVE_PREFIX = 'sre:case:active:';
const SUBJECT_PREFIX = 'sre:case:subject:';

function caseRedisKey(k: CaseKey): string {
  return `${CASE_PREFIX}${k.platform}:${k.channelId}:${k.userId}:${k.caseId}`;
}

function activeRedisKey(platform: string, channelId: string, userId: string): string {
  return `${ACTIVE_PREFIX}${platform}:${channelId}:${userId}`;
}

function subjectRedisKey(platform: string, channelId: string, userId: string, subjectKey: string): string {
  return `${SUBJECT_PREFIX}${platform}:${channelId}:${userId}:${subjectKey}`;
}

export class MemoryCaseStore implements CaseStore {
  private readonly data = new Map<string, AgentCase>();
  private readonly active = new Map<string, string>();
  private readonly subjectIndex = new Map<string, string>();

  private k(key: CaseKey): string {
    return `${key.platform}:${key.channelId}:${key.userId}:${key.caseId}`;
  }

  async get(key: CaseKey): Promise<AgentCase | undefined> {
    return this.data.get(this.k(key));
  }

  async set(key: CaseKey, agentCase: AgentCase): Promise<void> {
    this.data.set(this.k(key), agentCase);
    const sk = subjectDedupeKey(agentCase.subject);
    this.subjectIndex.set(
      `${key.platform}:${key.channelId}:${key.userId}:${sk}`,
      agentCase.caseId
    );
  }

  async delete(key: CaseKey): Promise<void> {
    const c = this.data.get(this.k(key));
    if (c) {
      const sk = subjectDedupeKey(c.subject);
      this.subjectIndex.delete(`${key.platform}:${key.channelId}:${key.userId}:${sk}`);
    }
    this.data.delete(this.k(key));
  }

  async findOpenBySubject(
    platform: string,
    channelId: string,
    userId: string,
    subjectKey: string
  ): Promise<AgentCase | undefined> {
    const caseId = this.subjectIndex.get(`${platform}:${channelId}:${userId}:${subjectKey}`);
    if (!caseId) return undefined;
    const c = await this.get({ platform, channelId, userId, caseId });
    if (!c || c.status === 'resolved') return undefined;
    return c;
  }

  async setActiveCase(
    platform: string,
    channelId: string,
    userId: string,
    caseId: string
  ): Promise<void> {
    this.active.set(`${platform}:${channelId}:${userId}`, caseId);
  }

  async getActiveCaseId(
    platform: string,
    channelId: string,
    userId: string
  ): Promise<string | undefined> {
    return this.active.get(`${platform}:${channelId}:${userId}`);
  }

  async close(): Promise<void> {
    this.data.clear();
    this.active.clear();
    this.subjectIndex.clear();
  }
}

export class RedisCaseStore implements CaseStore {
  private redis: import('ioredis').default | null = null;

  constructor(private readonly redisUrl: string) {}

  async connect(): Promise<void> {
    const { default: Redis } = await import('ioredis');
    this.redis = new Redis(this.redisUrl, { maxRetriesPerRequest: 2 });
    await this.redis.ping();
  }

  private client(): import('ioredis').default {
    if (!this.redis) throw new Error('Redis case store not connected');
    return this.redis;
  }

  private ttl(): number {
    return parseInt(process.env['CASE_TTL_SECONDS'] ?? '604800', 10);
  }

  async get(key: CaseKey): Promise<AgentCase | undefined> {
    const raw = await this.client().get(caseRedisKey(key));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as AgentCase;
    } catch {
      return undefined;
    }
  }

  async set(key: CaseKey, agentCase: AgentCase): Promise<void> {
    const ttl = this.ttl();
    await this.client().set(caseRedisKey(key), JSON.stringify(agentCase), 'EX', ttl);
    const sk = subjectDedupeKey(agentCase.subject);
    if (agentCase.status !== 'resolved') {
      await this.client().set(
        subjectRedisKey(key.platform, key.channelId, key.userId, sk),
        agentCase.caseId,
        'EX',
        ttl
      );
    }
  }

  async delete(key: CaseKey): Promise<void> {
    const c = await this.get(key);
    if (c) {
      const sk = subjectDedupeKey(c.subject);
      await this.client().del(
        subjectRedisKey(key.platform, key.channelId, key.userId, sk)
      );
    }
    await this.client().del(caseRedisKey(key));
  }

  async findOpenBySubject(
    platform: string,
    channelId: string,
    userId: string,
    subjectKey: string
  ): Promise<AgentCase | undefined> {
    const caseId = await this.client().get(
      subjectRedisKey(platform, channelId, userId, subjectKey)
    );
    if (!caseId) return undefined;
    const c = await this.get({ platform, channelId, userId, caseId });
    if (!c || c.status === 'resolved') return undefined;
    return c;
  }

  async setActiveCase(
    platform: string,
    channelId: string,
    userId: string,
    caseId: string
  ): Promise<void> {
    await this.client().set(activeRedisKey(platform, channelId, userId), caseId, 'EX', this.ttl());
  }

  async getActiveCaseId(
    platform: string,
    channelId: string,
    userId: string
  ): Promise<string | undefined> {
    const id = await this.client().get(activeRedisKey(platform, channelId, userId));
    return id ?? undefined;
  }

  async close(): Promise<void> {
    await this.redis?.quit();
    this.redis = null;
  }
}

let store: CaseStore = new MemoryCaseStore();

export function getCaseStore(): CaseStore {
  return store;
}

export async function initCaseStore(): Promise<{ backend: 'memory' | 'redis' }> {
  const redisUrl = process.env['REDIS_URL'];
  const backend = (process.env['CASE_STORE_BACKEND'] ?? (redisUrl ? 'redis' : 'memory')).toLowerCase();

  if (backend === 'redis' && redisUrl) {
    try {
      const redisStore = new RedisCaseStore(redisUrl);
      await redisStore.connect();
      store = redisStore;
      return { backend: 'redis' };
    } catch (err) {
      const { log } = await import('../../../shared/src/http.js');
      log('warn', 'commander-case-store', 'Redis unavailable — using in-memory cases', {
        error: String(err),
      });
    }
  }

  store = new MemoryCaseStore();
  return { backend: 'memory' };
}

import { log } from '../../../../shared/src/http.js';
import type { RunStore } from '../../../../shared/src/run-persistence.js';
import { FileRunStore } from './file-run-store.js';
import { RedisRunStore } from './redis-run-store.js';
import { PostgresRunStore } from './postgres-run-store.js';

const AGENT = 'orchestrator-run-store';

let store: RunStore | null = null;

async function buildStore(): Promise<RunStore> {
  const backend = (process.env['RUN_STORE_BACKEND'] ?? '').toLowerCase();
  const databaseUrl = process.env['DATABASE_URL'];
  const redisUrl = process.env['REDIS_URL'];
  const filePath = process.env['RUN_STORE_PATH'] ?? '/data/runs';

  if (backend === 'postgres' || (!backend && databaseUrl)) {
    const pgStore = new PostgresRunStore(databaseUrl!);
    await pgStore.initSchema();
    log('info', AGENT, 'Using Postgres run store', {});
    return pgStore;
  }

  if (backend === 'redis' || (!backend && redisUrl)) {
    const { Redis } = await import('ioredis');
    log('info', AGENT, 'Using Redis run store', {});
    return new RedisRunStore(new Redis(redisUrl!));
  }

  log('info', AGENT, 'Using file run store', { path: filePath });
  return new FileRunStore(filePath);
}

/** Initialize singleton run store (call once at startup). */
export async function createRunStore(): Promise<RunStore> {
  if (!store) store = await buildStore();
  return store;
}

export async function getRunStore(): Promise<RunStore> {
  return createRunStore();
}

export async function closeRunStore(): Promise<void> {
  if (store) {
    await store.close();
    store = null;
  }
}

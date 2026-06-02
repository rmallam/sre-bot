import { Redis } from 'ioredis';
import type { RunStore, StoredRun, PendingToolApproval } from '../../../../shared/src/run-persistence.js';
import type { RunStatus, ToolTranscriptEntry } from '../../../../shared/src/types.js';
import type { CompiledPlan } from '../../../../shared/src/tool-registry.js';
import type { ToolCall } from '../../../../shared/src/tool-contracts.js';

const KEY_PREFIX = 'sre:run:';
const INDEX_KEY = 'sre:run:index';
const TTL_SECONDS = parseInt(process.env['RUN_STORE_TTL_SECONDS'] ?? '604800', 10); // 7d

export class RedisRunStore implements RunStore {
  constructor(private readonly redis: Redis) {}

  private key(runId: string): string {
    return `${KEY_PREFIX}${runId}`;
  }

  private async read(runId: string): Promise<StoredRun | undefined> {
    const raw = await this.redis.get(this.key(runId));
    if (!raw) return undefined;
    return JSON.parse(raw) as StoredRun;
  }

  private async write(run: StoredRun): Promise<void> {
    run.updatedAt = new Date().toISOString();
    await this.redis
      .multi()
      .set(this.key(run.runId), JSON.stringify(run), 'EX', TTL_SECONDS)
      .zadd(INDEX_KEY, Date.now(), run.runId)
      .exec();
  }

  async initRun(runId: string, incidentId: string, metadata?: Record<string, unknown>): Promise<void> {
    const now = new Date().toISOString();
    await this.write({
      runId,
      incidentId,
      status: 'running',
      transcript: [],
      startedAt: now,
      updatedAt: now,
      metadata,
    });
  }

  async getRun(runId: string): Promise<StoredRun | undefined> {
    return this.read(runId);
  }

  async listRuns(opts?: { incidentId?: string; limit?: number }): Promise<StoredRun[]> {
    const ids = await this.redis.zrevrange(INDEX_KEY, 0, (opts?.limit ?? 50) - 1);
    const runs: StoredRun[] = [];
    for (const id of ids) {
      const run = await this.read(id);
      if (!run) continue;
      if (opts?.incidentId && run.incidentId !== opts.incidentId) continue;
      runs.push(run);
    }
    return runs;
  }

  async setRunCompiled(runId: string, compiled: CompiledPlan): Promise<void> {
    const run = await this.read(runId);
    if (!run) return;
    run.compiled = compiled;
    await this.write(run);
  }

  async setCapabilityPlan(runId: string, toolCalls: ToolCall[], compiled: CompiledPlan): Promise<void> {
    const run = await this.read(runId);
    if (!run) return;
    run.capabilityToolCalls = toolCalls;
    run.compiled = compiled;
    await this.write(run);
  }

  async appendTranscript(runId: string, entries: ToolTranscriptEntry[]): Promise<void> {
    const run = await this.read(runId);
    if (!run) return;
    run.transcript.push(...entries);
    await this.write(run);
  }

  async setRunStatus(runId: string, status: RunStatus): Promise<void> {
    const run = await this.read(runId);
    if (!run) return;
    run.status = status;
    await this.write(run);
  }

  async setResumeFromToolIndex(runId: string, index: number | null): Promise<void> {
    const run = await this.read(runId);
    if (!run) return;
    if (index === null || index < 0) delete run.resumeFromToolIndex;
    else run.resumeFromToolIndex = index;
    await this.write(run);
  }

  async setPendingToolApproval(
    runId: string,
    pending: PendingToolApproval | undefined
  ): Promise<void> {
    const run = await this.read(runId);
    if (!run) return;
    run.pendingToolApproval = pending;
    await this.write(run);
  }

  async mergeRunMetadata(runId: string, patch: Record<string, unknown>): Promise<void> {
    const run = await this.read(runId);
    if (!run) return;
    run.metadata = { ...(run.metadata ?? {}), ...patch };
    await this.write(run);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

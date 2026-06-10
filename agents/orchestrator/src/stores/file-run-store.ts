import { existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunStore, StoredRun } from '../../../../shared/src/run-persistence.js';
import type { RunStatus, ToolTranscriptEntry } from '../../../../shared/src/types.js';
import type { CompiledPlan } from '../../../../shared/src/tool-registry.js';
import type { ToolCall } from '../../../../shared/src/tool-contracts.js';
import type { PendingToolApproval } from '../../../../shared/src/run-persistence.js';

export class FileRunStore implements RunStore {
  constructor(private readonly basePath: string) {}

  private path(runId: string): string {
    return join(this.basePath, `${runId}.json`);
  }

  private async read(runId: string): Promise<StoredRun | undefined> {
    const p = this.path(runId);
    if (!existsSync(p)) return undefined;
    const raw = await readFile(p, 'utf-8');
    return JSON.parse(raw) as StoredRun;
  }

  private async write(run: StoredRun): Promise<void> {
    await mkdir(this.basePath, { recursive: true });
    run.updatedAt = new Date().toISOString();
    await writeFile(this.path(run.runId), JSON.stringify(run, null, 2), 'utf-8');
  }

  async initRun(
    runId: string,
    incidentId: string,
    metadata?: Record<string, unknown>,
    options?: { status?: RunStatus }
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.write({
      runId,
      incidentId,
      status: options?.status ?? 'running',
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
    if (!existsSync(this.basePath)) return [];
    const files = await readdir(this.basePath);
    const runs: StoredRun[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const run = await this.read(f.replace(/\.json$/, ''));
      if (!run) continue;
      if (opts?.incidentId && run.incidentId !== opts.incidentId) continue;
      runs.push(run);
    }
    runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return runs.slice(0, opts?.limit ?? 50);
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

  async listPendingThrottledRuns(limit = 50): Promise<StoredRun[]> {
    const runs = await this.listRuns({ limit: 500 });
    return runs
      .filter((r) => r.status === 'pending_throttled')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .slice(0, limit);
  }

  async claimThrottledRun(runId: string): Promise<boolean> {
    const lockPath = join(this.basePath, `.${runId}.claim.lock`);
    try {
      const fh = await open(lockPath, 'wx');
      await fh.close();
    } catch {
      return false;
    }
    try {
      const run = await this.read(runId);
      if (!run || run.status !== 'pending_throttled') return false;
      run.status = 'running';
      await this.write(run);
      return true;
    } finally {
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async close(): Promise<void> {}
}

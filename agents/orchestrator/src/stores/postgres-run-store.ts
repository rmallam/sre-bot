import pg from 'pg';
import type { RunStore, StoredRun, PendingToolApproval } from '../../../../shared/src/run-persistence.js';
import type { RunStatus, ToolTranscriptEntry } from '../../../../shared/src/types.js';
import type { CompiledPlan } from '../../../../shared/src/tool-registry.js';
import type { ToolCall } from '../../../../shared/src/tool-contracts.js';
import { resourceKeyFromStartRequest } from '../../../../shared/src/remediation-outcome.js';
import type { StartRunRequest } from '../../../../shared/src/types.js';

const { Pool } = pg;

export class PostgresRunStore implements RunStore {
  private pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async initSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sre_runs (
        run_id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL,
        status TEXT NOT NULL,
        compiled JSONB,
        capability_tool_calls JSONB,
        transcript JSONB NOT NULL DEFAULT '[]',
        resume_from_tool_index INT,
        pending_tool_approval JSONB,
        metadata JSONB,
        started_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sre_runs_incident ON sre_runs(incident_id);
      CREATE INDEX IF NOT EXISTS idx_sre_runs_updated ON sre_runs(updated_at DESC);
    `);
    await this.pool.query(`
      ALTER TABLE sre_runs ADD COLUMN IF NOT EXISTS resource_key TEXT;
    `);
    await this.pool.query(`
      ALTER TABLE sre_runs ADD COLUMN IF NOT EXISTS namespace TEXT;
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_sre_runs_active_resource
      ON sre_runs(resource_key, updated_at DESC)
      WHERE status IN ('running', 'awaiting_human');
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_sre_runs_active_namespace
      ON sre_runs(namespace, updated_at DESC)
      WHERE status IN ('running', 'awaiting_human') AND namespace IS NOT NULL;
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_sre_runs_pending_throttled
      ON sre_runs(started_at ASC)
      WHERE status = 'pending_throttled';
    `);
    await this.pool.query(`
      UPDATE sre_runs
      SET namespace = metadata->'request'->>'namespace'
      WHERE namespace IS NULL AND metadata->'request'->>'namespace' IS NOT NULL;
    `);
  }

  private rowToRun(row: Record<string, unknown>): StoredRun {
    return {
      runId: row.run_id as string,
      incidentId: row.incident_id as string,
      status: row.status as RunStatus,
      compiled: row.compiled as CompiledPlan | undefined,
      capabilityToolCalls: row.capability_tool_calls as ToolCall[] | undefined,
      transcript: (row.transcript as ToolTranscriptEntry[]) ?? [],
      resumeFromToolIndex: row.resume_from_tool_index as number | undefined,
      pendingToolApproval: row.pending_tool_approval as PendingToolApproval | undefined,
      metadata: row.metadata as Record<string, unknown> | undefined,
      startedAt: (row.started_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
    };
  }

  async initRun(
    runId: string,
    incidentId: string,
    metadata?: Record<string, unknown>,
    options?: { status?: RunStatus }
  ): Promise<void> {
    const now = new Date();
    const status = options?.status ?? 'running';
    const req = metadata?.request as StartRunRequest | undefined;
    const resourceKey = req ? resourceKeyFromStartRequest(req) : `run:${incidentId}`;
    const namespace = req?.namespace?.trim() || null;
    await this.pool.query(
      `INSERT INTO sre_runs (run_id, incident_id, status, transcript, metadata, resource_key, namespace, started_at, updated_at)
       VALUES ($1, $2, $3, '[]'::jsonb, $4, $5, $6, $7, $7)
       ON CONFLICT (run_id) DO UPDATE SET updated_at = $7, resource_key = COALESCE(sre_runs.resource_key, $5), namespace = COALESCE(sre_runs.namespace, $6)`,
      [runId, incidentId, status, metadata ?? null, resourceKey, namespace, now]
    );
  }

  async countActiveRunsByNamespace(namespace: string): Promise<number> {
    const res = await this.pool.query(
      `SELECT COUNT(*)::int AS cnt FROM sre_runs
       WHERE namespace = $1 AND status IN ('running', 'awaiting_human')`,
      [namespace.trim()]
    );
    return Number((res.rows[0] as { cnt?: number })?.cnt ?? 0);
  }

  async listPendingThrottledRuns(limit = 50): Promise<StoredRun[]> {
    const res = await this.pool.query(
      `SELECT * FROM sre_runs
       WHERE status = 'pending_throttled'
       ORDER BY started_at ASC
       LIMIT $1`,
      [limit]
    );
    return res.rows.map((r) => this.rowToRun(r as Record<string, unknown>));
  }

  async claimThrottledRun(runId: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE sre_runs SET status = 'running', updated_at = NOW()
       WHERE run_id = $1 AND status = 'pending_throttled'`,
      [runId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** PLAT-13 — indexed lookup for run dedupe at scale. */
  async findActiveRunByResourceKey(resourceKey: string): Promise<StoredRun | undefined> {
    const res = await this.pool.query(
      `SELECT * FROM sre_runs
       WHERE resource_key = $1 AND status IN ('running', 'awaiting_human')
       ORDER BY updated_at DESC LIMIT 1`,
      [resourceKey]
    );
    if (res.rowCount === 0) return undefined;
    return this.rowToRun(res.rows[0] as Record<string, unknown>);
  }

  async getRun(runId: string): Promise<StoredRun | undefined> {
    const res = await this.pool.query(`SELECT * FROM sre_runs WHERE run_id = $1`, [runId]);
    if (res.rowCount === 0) return undefined;
    return this.rowToRun(res.rows[0] as Record<string, unknown>);
  }

  async listRuns(opts?: { incidentId?: string; limit?: number }): Promise<StoredRun[]> {
    const limit = opts?.limit ?? 50;
    const res = opts?.incidentId
      ? await this.pool.query(
          `SELECT * FROM sre_runs WHERE incident_id = $1 ORDER BY updated_at DESC LIMIT $2`,
          [opts.incidentId, limit]
        )
      : await this.pool.query(`SELECT * FROM sre_runs ORDER BY updated_at DESC LIMIT $1`, [limit]);
    return res.rows.map((r) => this.rowToRun(r as Record<string, unknown>));
  }

  private async patch(runId: string, fields: Record<string, unknown>): Promise<void> {
    const sets: string[] = ['updated_at = NOW()'];
    const vals: unknown[] = [];
    let i = 1;
    for (const [col, val] of Object.entries(fields)) {
      sets.push(`${col} = $${i++}`);
      vals.push(val);
    }
    vals.push(runId);
    await this.pool.query(
      `UPDATE sre_runs SET ${sets.join(', ')} WHERE run_id = $${i}`,
      vals
    );
  }

  async setRunCompiled(runId: string, compiled: CompiledPlan): Promise<void> {
    await this.patch(runId, { compiled });
  }

  async setCapabilityPlan(runId: string, toolCalls: ToolCall[], compiled: CompiledPlan): Promise<void> {
    await this.patch(runId, {
      capability_tool_calls: toolCalls,
      compiled,
    });
  }

  async appendTranscript(runId: string, entries: ToolTranscriptEntry[]): Promise<void> {
    await this.pool.query(
      `UPDATE sre_runs SET transcript = transcript || $1::jsonb, updated_at = NOW() WHERE run_id = $2`,
      [JSON.stringify(entries), runId]
    );
  }

  async setRunStatus(runId: string, status: RunStatus): Promise<void> {
    await this.patch(runId, { status });
  }

  async setResumeFromToolIndex(runId: string, index: number | null): Promise<void> {
    await this.patch(runId, { resume_from_tool_index: index === null || index < 0 ? null : index });
  }

  async setPendingToolApproval(
    runId: string,
    pending: PendingToolApproval | undefined
  ): Promise<void> {
    await this.patch(runId, {
      pending_tool_approval: pending ?? null,
    });
  }

  async mergeRunMetadata(runId: string, patch: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `UPDATE sre_runs SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb, updated_at = NOW() WHERE run_id = $2`,
      [JSON.stringify(patch), runId]
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

import type { RunStatus, ToolTranscriptEntry, StartRunRequest } from '../../../shared/src/types.js';
import type { CompiledPlan } from '../../../shared/src/tool-registry.js';
import type { ToolCall } from '../../../shared/src/tool-contracts.js';
import type { PendingToolApproval, StoredRun } from '../../../shared/src/run-persistence.js';
import { runResourceKey, resourceKeyFromStartRequest } from '../../../shared/src/remediation-outcome.js';
import { getRunStore } from './stores/index.js';

export type { StoredRun, PendingToolApproval };

export async function initRun(
  runId: string,
  incidentId: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await (await getRunStore()).initRun(runId, incidentId, metadata);
}

export async function getRun(runId: string): Promise<StoredRun | undefined> {
  return (await getRunStore()).getRun(runId);
}

/** Exact match, then unique prefix match (for truncated links). */
export async function resolveRun(runIdOrPrefix: string): Promise<StoredRun | undefined> {
  const trimmed = runIdOrPrefix.trim();
  if (!trimmed) return undefined;
  const exact = await getRun(trimmed);
  if (exact) return exact;
  if (trimmed.length < 8) return undefined;
  const runs = await listRuns({ limit: 500 });
  const matches = runs.filter((r) => r.runId.startsWith(trimmed));
  return matches.length === 1 ? matches[0] : undefined;
}

export async function listRuns(opts?: {
  incidentId?: string;
  limit?: number;
}): Promise<StoredRun[]> {
  return (await getRunStore()).listRuns(opts);
}

export async function setRunCompiled(runId: string, compiled: CompiledPlan): Promise<void> {
  await (await getRunStore()).setRunCompiled(runId, compiled);
}

export async function setCapabilityPlan(
  runId: string,
  toolCalls: ToolCall[],
  compiled: CompiledPlan
): Promise<void> {
  await (await getRunStore()).setCapabilityPlan(runId, toolCalls, compiled);
}

export async function appendRunTranscript(
  runId: string,
  entries: ToolTranscriptEntry[]
): Promise<void> {
  await (await getRunStore()).appendTranscript(runId, entries);
}

export async function setRunStatus(runId: string, status: RunStatus): Promise<void> {
  await (await getRunStore()).setRunStatus(runId, status);
}

export async function setResumeFromToolIndex(runId: string, index: number | null): Promise<void> {
  await (await getRunStore()).setResumeFromToolIndex(runId, index);
}

export async function setPendingToolApproval(
  runId: string,
  pending: PendingToolApproval | undefined
): Promise<void> {
  await (await getRunStore()).setPendingToolApproval(runId, pending);
}

export async function mergeRunMetadata(
  runId: string,
  patch: Record<string, unknown>
): Promise<void> {
  await (await getRunStore()).mergeRunMetadata(runId, patch);
}

const ACTIVE_STATUSES = new Set<RunStatus>(['running', 'awaiting_human']);

/** PLAT-13 — prefer Postgres index; fallback scan for file/redis stores. */
export async function findActiveRunByResourceKey(
  incoming: StartRunRequest
): Promise<StoredRun | undefined> {
  const key = resourceKeyFromStartRequest(incoming);
  const store = await getRunStore();
  if ('findActiveRunByResourceKey' in store) {
    const fn = store.findActiveRunByResourceKey as (k: string) => Promise<StoredRun | undefined>;
    const hit = await fn.call(store, key);
    if (hit) return hit;
  }
  const limit = parseInt(process.env['ORCHESTRATOR_DEDUPE_SCAN_LIMIT'] ?? '200', 10);
  const runs = await store.listRuns({ limit });
  return runs.find((r) => ACTIVE_STATUSES.has(r.status) && runResourceKey(r) === key);
}

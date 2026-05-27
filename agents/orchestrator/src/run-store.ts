import type { RunStatus, ToolTranscriptEntry } from '../../../shared/src/types.js';
import type { CompiledPlan } from '../../../shared/src/tool-registry.js';
import type { ToolCall } from '../../../shared/src/tool-contracts.js';
import type { PendingToolApproval, StoredRun } from '../../../shared/src/run-persistence.js';
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

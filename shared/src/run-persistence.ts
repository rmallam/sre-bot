/**
 * Persistent run store contract — transcripts, compiled plans, resume checkpoints.
 */

import type {
  RunStatus,
  ToolTranscriptEntry,
  PendingToolApproval,
} from './types.js';
import type { CompiledPlan } from './tool-registry.js';
import type { ToolCall } from './tool-contracts.js';

export type { PendingToolApproval };

/** Coerce persisted JSON into a ToolCall array (handles object-shaped legacy data). */
export function normalizeToolCalls(raw: unknown): ToolCall[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter(
      (c): c is ToolCall =>
        !!c && typeof c === 'object' && typeof (c as ToolCall).name === 'string'
    );
  }
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.name === 'string') {
      return [obj as ToolCall];
    }
    return Object.values(obj).filter(
      (c): c is ToolCall =>
        !!c && typeof c === 'object' && typeof (c as ToolCall).name === 'string'
    );
  }
  return [];
}

export function toolCallNames(raw: unknown): string[] {
  return normalizeToolCalls(raw).map((c) => c.name);
}

export function normalizeStoredRun(run: StoredRun): StoredRun {
  const capabilityToolCalls = normalizeToolCalls(run.capabilityToolCalls);
  let compiled = run.compiled;
  if (compiled && !Array.isArray(compiled.calls)) {
    compiled = {
      ...compiled,
      calls: normalizeToolCalls((compiled as CompiledPlan & { calls?: unknown }).calls),
    };
  }
  return {
    ...run,
    capabilityToolCalls: capabilityToolCalls.length ? capabilityToolCalls : undefined,
    transcript: Array.isArray(run.transcript) ? run.transcript : [],
    compiled,
  };
}

export interface StoredRun {
  runId: string;
  incidentId: string;
  status: RunStatus;
  transcript: ToolTranscriptEntry[];
  compiled?: CompiledPlan;
  capabilityToolCalls?: ToolCall[];
  startedAt: string;
  updatedAt: string;
  resumeFromToolIndex?: number;
  pendingToolApproval?: PendingToolApproval;
  metadata?: Record<string, unknown>;
}

export interface InitRunOptions {
  status?: RunStatus;
}

export interface RunStore {
  initRun(
    runId: string,
    incidentId: string,
    metadata?: Record<string, unknown>,
    options?: InitRunOptions
  ): Promise<void>;
  getRun(runId: string): Promise<StoredRun | undefined>;
  listRuns(opts?: { incidentId?: string; limit?: number }): Promise<StoredRun[]>;
  setRunCompiled(runId: string, compiled: CompiledPlan): Promise<void>;
  setCapabilityPlan(runId: string, toolCalls: ToolCall[], compiled: CompiledPlan): Promise<void>;
  appendTranscript(runId: string, entries: ToolTranscriptEntry[]): Promise<void>;
  setRunStatus(runId: string, status: RunStatus): Promise<void>;
  setResumeFromToolIndex(runId: string, index: number | null): Promise<void>;
  setPendingToolApproval(runId: string, pending: PendingToolApproval | undefined): Promise<void>;
  mergeRunMetadata(runId: string, patch: Record<string, unknown>): Promise<void>;
  countActiveRunsByNamespace?(namespace: string): Promise<number>;
  listPendingThrottledRuns?(limit?: number): Promise<StoredRun[]>;
  claimThrottledRun?(runId: string): Promise<boolean>;
  close(): Promise<void>;
}

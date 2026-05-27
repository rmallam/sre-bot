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

export interface RunStore {
  initRun(runId: string, incidentId: string, metadata?: Record<string, unknown>): Promise<void>;
  getRun(runId: string): Promise<StoredRun | undefined>;
  listRuns(opts?: { incidentId?: string; limit?: number }): Promise<StoredRun[]>;
  setRunCompiled(runId: string, compiled: CompiledPlan): Promise<void>;
  setCapabilityPlan(runId: string, toolCalls: ToolCall[], compiled: CompiledPlan): Promise<void>;
  appendTranscript(runId: string, entries: ToolTranscriptEntry[]): Promise<void>;
  setRunStatus(runId: string, status: RunStatus): Promise<void>;
  setResumeFromToolIndex(runId: string, index: number | null): Promise<void>;
  setPendingToolApproval(runId: string, pending: PendingToolApproval | undefined): Promise<void>;
  close(): Promise<void>;
}

import type { IncidentMode, RemediationPlan, ResourceKind, StartRunRequest } from './types.js';

export type ToolCallName =
  | 'investigator.repo_inspect'
  | 'executor.restart_workload'
  | 'gitops.apply_plan'
  | 'investigator.verify_health'
  | 'commander.notify'
  | 'argo.wait_sync'
  | 'argo.rollout_promote';

export interface ToolCall<TInput = unknown> {
  name: ToolCallName;
  input: TInput;
}

export interface RuntimeToolContext {
  incidentId: string;
  runId: string;
  mode: IncidentMode;
  namespace: string;
  resourceName: string;
  resourceKind: ResourceKind;
  request: StartRunRequest;
  plan: RemediationPlan;
}

export interface RepoInspectInput {
  incidentId: string;
  githubRepo: string;
  gitRef?: string;
  namespace: string;
  resourceName: string;
}

export interface RestartInput {
  incidentId: string;
  runId: string;
  namespace: string;
  resourceName: string;
  resourceKind: ResourceKind;
}

export interface GitopsApplyInput {
  incidentId: string;
  runId: string;
  mode: IncidentMode;
  namespace: string;
  resourceName: string;
  resourceKind: ResourceKind;
  plan: RemediationPlan;
  request: StartRunRequest;
}

export interface VerifyHealthInput {
  incidentId: string;
  namespace: string;
  resourceName: string;
}

export interface NotifyInput {
  incidentId: string;
  runId?: string;
  platform?: string;
  channelId?: string;
  message: string;
}

export interface ArgoWaitSyncInput {
  incidentId: string;
  appName: string;
  timeoutMs?: number;
}

export interface ArgoRolloutPromoteInput {
  incidentId: string;
  namespace: string;
  rolloutName: string;
}


import type { IncidentMode, RemediationPlan, ResourceKind, StartRunRequest } from './types.js';

export type ToolCallName =
  | 'investigator.repo_inspect'
  | 'executor.restart_workload'
  | 'gitops.apply_plan'
  | 'investigator.verify_health'
  | 'commander.notify'
  | 'argo.wait_sync'
  | 'argo.rollout_promote'
  | 'cicd.fetch_run'
  | 'cicd.rerun_workflow'
  | 'cicd.open_pr'
  | 'cicd.open_code_pr'
  | 'coding_agent.run_fix'
  | 'investigator.logs_query'
  | 'investigator.metrics_query';

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
  /** Populated for ci-failure runs (coding agent handoff). */
  ciRun?: import('./ci-types.js').CiRunFacts;
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

export interface CicdFetchRunInput {
  incidentId: string;
  githubRepo: string;
  workflowRunId?: number;
  branch?: string;
  workflowName?: string;
}

export interface CicdRerunInput {
  incidentId: string;
  githubRepo: string;
  workflowRunId: number;
}

export interface CicdOpenPrInput {
  incidentId: string;
  githubRepo: string;
  branch: string;
  title: string;
  body: string;
}

export interface CicdOpenCodePrInput {
  incidentId: string;
  githubRepo: string;
  branch: string;
  title: string;
  body: string;
  patches: Array<{ path: string; content: string }>;
}

export interface CodingAgentRunFixInput {
  incidentId: string;
  runId: string;
  ciRun: import('./ci-types.js').CiRunFacts;
  platform?: string;
  channelId?: string;
  maxAttempts?: number;
}

export interface LogsQueryInput {
  incidentId: string;
  namespace?: string;
  podName?: string;
  labelSelector?: string;
  sinceMinutes?: number;
}

export interface MetricsQueryInput {
  incidentId: string;
  namespace?: string;
  deployment?: string;
}


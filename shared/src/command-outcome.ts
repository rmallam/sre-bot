/**
 * UX-18 — Structured facts for synchronous commander replies (delete, get, status, health).
 * Commander composes these into chat-friendly messages; agents do not emit prose.
 */

import type { WorkloadStatusFacts } from './workload-status.js';

export interface UndeployFound {
  helmRelease: boolean;
  deployment: boolean;
  service: boolean;
  labeledResources: number;
}

export type UndeployActionType =
  | 'helm_uninstalled'
  | 'deployment_deleted'
  | 'deployment_removed_by_helm'
  | 'service_deleted'
  | 'labeled_resources_deleted'
  | 'action_failed';

export interface UndeployAction {
  type: UndeployActionType;
  /** Human detail when type is action_failed */
  detail?: string;
  count?: number;
}

export type UndeploySkippedType = 'helm' | 'deployment' | 'service' | 'labeled';

export interface UndeploySkipped {
  type: UndeploySkippedType;
  reason: 'not_present' | 'already_removed';
}

export interface UndeployOutcomePayload {
  releaseName: string;
  namespace: string;
  found: UndeployFound;
  actions: UndeployAction[];
  skipped: UndeploySkipped[];
  incomplete?: boolean;
}

export interface ClusterGetOutcome {
  resource: string;
  namespace?: string;
  total: number;
  shown: number;
  /** Raw kubectl-style table from investigator */
  text: string;
}

export interface HealthOutcome {
  label: string;
  summary?: string;
  warnings: Array<{ reason: string; message: string }>;
  deployments: string[];
  evidence?: string;
  /** False when investigator could not reach a live cluster API. */
  clusterReachable?: boolean;
}

export interface ChoicePromptOutcome {
  subject: string;
  options: Array<{ label: string; score?: number }>;
}

export interface EventInvestigationOutcome {
  reason: string;
  message: string;
  severity: 'benign' | 'warning' | 'critical';
  title: string;
  explanation: string;
  recommendation: string;
  clusterHealthy: boolean;
  currentNotes: string[];
}

export interface AppReviewOutcome {
  appId: string;
  namespace: string;
  overallStatus: 'ok' | 'degraded' | 'down' | 'unknown';
  narrative: string;
  frontierName?: string;
  frontierKind?: string;
  frontierDetail?: string;
  nodeCount: number;
  clusterReachable?: boolean;
  reachable: boolean;
  error?: string;
}

export type CommandOutcome =
  | { kind: 'undeploy'; ok: boolean; userHint?: string; payload: UndeployOutcomePayload }
  | { kind: 'workload_status'; facts: WorkloadStatusFacts }
  | { kind: 'cluster_get'; data: ClusterGetOutcome }
  | { kind: 'health'; data: HealthOutcome }
  | { kind: 'event_investigation'; data: EventInvestigationOutcome }
  | { kind: 'app_review'; data: AppReviewOutcome }
  | { kind: 'not_found'; subject: string; namespace?: string; context?: string }
  | { kind: 'choice_prompt'; data: ChoicePromptOutcome }
  | { kind: 'plain'; text: string };

export interface ComposeOptions {
  verbose?: boolean;
  incidentId?: string;
  platform?: string;
}

export type ApprovalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'IGNORED'
  | 'EXPIRED'
  | 'EXECUTING'
  | 'DONE'
  | 'FAILED';

export type RunStatus =
  | 'running'
  | 'awaiting_human'
  | 'succeeded'
  | 'failed'
  | 'escalated'
  | 'cancelled';

export interface RemediationPlan {
  action: string;
  rootCause: string;
  reasoning: string;
  severity: string;
  proposedPatch: Array<{ op: string; path: string; value?: unknown }>;
  targetManifestPath?: string;
  commitMessage?: string;
  rollbackSafe?: boolean;
}

export interface Approval {
  incidentId: string;
  runId?: string;
  status: ApprovalStatus;
  expiresAt: string;
  lockedBy?: string;
  lockedVia?: string;
  namespace: string;
  resourceName: string;
  resourceKind: string;
  mode: string;
  escalated?: boolean;
  attemptNumber?: number;
  circuitBreakerLimit?: number;
  plan: RemediationPlan;
  humanSuggestion?: string;
  planSource?: string;
  triggeredAt: string;
  triggeredBy: string;
}

export interface RunListItem {
  runId: string;
  incidentId: string;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  toolCount: number;
  mode?: string;
  namespace?: string;
  resourceName?: string;
  githubRepo?: string;
  resourceKey?: string;
  displayName?: string;
  outcome?: RemediationOutcome;
}

export interface RemediationActionTaken {
  action: string;
  success: boolean;
  summary: string;
  verifyStatus?: string;
  commitUrls?: string[];
  at?: string;
}

export interface RemediationOutcome {
  resourceKey: string;
  suggestedAction: string;
  rootCause?: string;
  reasoning?: string;
  severity?: string;
  planSource?: 'bot' | 'human';
  worked: boolean | null;
  finalStatus: RunStatus;
  humanDecision?: 'approved' | 'rejected' | 'ignored' | 'auto' | 'pending';
  actionsTaken: RemediationActionTaken[];
  followUp?: string;
  recordedAt: string;
  skillSummary: string;
}

export interface ResourceRunGroup {
  resourceKey: string;
  displayName: string;
  kind: 'k8s' | 'ci' | 'unknown';
  namespace?: string;
  resourceName?: string;
  githubRepo?: string;
  latestStatus: RunStatus;
  attemptCount: number;
  successCount: number;
  lastUpdated: string;
  runs: RunListItem[];
}

export interface IgnoredResource {
  key: string;
  namespace: string;
  resourceName: string;
  ignoredAt: string;
  ignoredBy: string;
  sourceIncidentId: string;
}

export interface OverviewStats {
  pendingApprovals: number;
  runsTotal: number;
  runsRunning: number;
  runsAwaiting: number;
  runsSucceeded: number;
  runsFailed: number;
  runsCancelled: number;
}

export interface AgentHealth {
  name: string;
  ok: boolean;
  status: string;
}

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

export type ClusterHealthStatus = 'healthy' | 'degraded' | 'unreachable';

export type ClusterHealthDisplayStatus = 'healthy' | 'degrading' | 'apps_failing' | 'unreachable';

export interface ClusterHealthNode {
  name: string;
  ready: boolean;
}

export interface ClusterHealthDeployment {
  namespace: string;
  name: string;
  ready: number;
  desired: number;
}

export interface ClusterHealthPodIssue {
  namespace: string;
  name: string;
  phase: string;
  reason: string;
}

export interface ClusterHealthEvent {
  namespace: string;
  reason: string;
  object: string;
  message: string;
  lastTime: string;
}

export interface ClusterHealthSnapshot {
  reachable: boolean;
  checkedAt: string;
  error?: string;
  status: ClusterHealthStatus;
  displayStatus: ClusterHealthDisplayStatus;
  statusSummary: string;
  nodes: {
    total: number;
    ready: number;
    notReady: number;
    items: ClusterHealthNode[];
  };
  pods: {
    total: number;
    running: number;
    pending: number;
    failed: number;
    problematic: number;
    issues: ClusterHealthPodIssue[];
  };
  deployments: {
    total: number;
    unhealthy: number;
    items: ClusterHealthDeployment[];
  };
  warningEvents: ClusterHealthEvent[];
  eventWindowMinutes: number;
}

export interface AppGraphNode {
  id: string;
  kind: 'deployment' | 'service' | 'ingress' | 'pod' | 'external';
  namespace: string;
  name: string;
  status: 'ok' | 'degraded' | 'down' | 'unknown';
  detail: string;
  ready?: number;
  desired?: number;
}

export interface AppGraph {
  appId: string;
  namespace: string;
  nodes: AppGraphNode[];
  edges: Array<{ from: string; to: string; kind: string }>;
}

export interface AppReviewResult {
  appId: string;
  namespace: string;
  checkedAt: string;
  reachable: boolean;
  clusterReachable: boolean;
  overallStatus: 'ok' | 'degraded' | 'down' | 'unknown';
  frontierNodeId?: string;
  narrative: string;
  graph: AppGraph;
  error?: string;
}

export interface AppListEntry {
  appId: string;
  namespace: string;
  deploymentCount: number;
  source: 'annotation' | 'deployment-name';
}

export interface AppsListResult {
  apps: AppListEntry[];
  clusterReachable: boolean;
  error?: string;
}

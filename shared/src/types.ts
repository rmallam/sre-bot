// ─────────────────────────────────────────────────────────────────────────────
// Shared payload types for the Kube SRE Microservice Agent Framework
// ─────────────────────────────────────────────────────────────────────────────

export type Platform = 'slack' | 'telegram' | 'teams' | 'web';
export type ResourceKind = 'Deployment' | 'StatefulSet' | 'Pod' | 'Job' | 'DaemonSet';
export type IncidentMode = 'diagnose' | 'pre-deploy' | 'rollback';
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ApprovalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'EXECUTING'
  | 'DONE'
  | 'FAILED';

export type RemediationAction =
  | 'restart'
  | 'git_patch'
  | 'helm_deploy'
  | 'repo_apply'
  | 'escalate_human'
  | 'noop';

export type AutonomyMode = 'full' | 'low_risk_only' | 'hil_all';

export type RunStatus =
  | 'running'
  | 'awaiting_human'
  | 'succeeded'
  | 'failed'
  | 'escalated';

export type VerifyStatus = 'healthy' | 'degraded' | 'unknown';

export type SecurityFindingSeverity = 'LOW' | 'MEDIUM' | 'HIGH';

export type SecurityFindingAction = 'redacted' | 'removed' | 'blocked';

export interface SecurityFinding {
  type: string;
  field?: string;
  severity: SecurityFindingSeverity;
  action: SecurityFindingAction;
  message: string;
}

export interface IncidentEnvelope {
  incidentId: string;
  triggeredBy: 'watcher' | 'commander';
  triggeredAt: string;
  namespace: string;
  resourceKind: ResourceKind;
  resourceName: string;
  mode: IncidentMode;
}

export interface AnomalyDetected extends IncidentEnvelope {
  podName: string;
  eventReason: string;
  eventMessage: string;
  containerName?: string;
}

export interface DeployRequest extends IncidentEnvelope {
  githubRepo: string;
  gitRef?: string;
  deployStrategy?: 'gitops' | 'direct';
  requestedBy: string;
  platform: Platform;
  channelId: string;
  rawMessage: string;
}

export interface RepoSignals {
  hasDockerfile?: boolean;
  hasPackageJson?: boolean;
  hasGoMod?: boolean;
  primaryLanguage?: string;
  suggestedImage?: string;
}

export interface DiagnosisContext extends IncidentEnvelope {
  podSpec: object;
  containerStatuses: object[];
  resourceLimits: object;
  nodeInfo?: object;
  recentEvents: KubeEvent[];
  currentLogs: string;
  previousLogs: string;
  gitRepoUrl?: string;
  gitManifestPath?: string;
  gitManifestContent?: string;
  namespaceExists?: boolean;
  namespaceQuotas?: object;
  existingDeployments?: string[];
  requestedBy?: string;
  platform?: Platform;
  channelId?: string;
  githubRepo?: string;
  needsHelmGeneration?: boolean;
  repoEntryPointKind?: 'helm' | 'kustomize' | 'plain-yaml' | 'unknown';
  repoSignals?: RepoSignals;
  priorActionSummary?: string;
  safeMode?: boolean;
}

/** Facts safe to send to an LLM after security-agent sanitization. */
export interface SanitizedFacts extends Omit<
  DiagnosisContext,
  'currentLogs' | 'previousLogs' | 'gitManifestContent'
> {
  currentLogs: string;
  previousLogs: string;
  gitManifestContent?: string;
  sanitizeBlocked?: boolean;
}

export interface KubeEvent {
  reason: string;
  message: string;
  count: number;
  firstTime: string;
  lastTime: string;
  type: 'Normal' | 'Warning';
}

export interface JsonPatchOp {
  op: 'replace' | 'add' | 'remove' | 'test';
  path: string;
  value?: unknown;
}

export interface HelmChartPayload {
  files: Record<string, string>;
}

export interface RemediationPlan {
  action: RemediationAction;
  rootCause: string;
  reasoning: string;
  severity: Severity;
  proposedPatch: JsonPatchOp[];
  targetManifestPath: string;
  commitMessage: string;
  rollbackSafe: boolean;
  helmChart?: HelmChartPayload;
  targetRepo?: 'app' | 'gitops' | 'both';
  githubRepo?: string;
  gitRef?: string;
}

export interface ToolTranscriptEntry {
  at: string;
  tool: string;
  attempt: number;
  success: boolean;
  summary?: string;
  error?: string;
  durationMs: number;
  idempotencyKey: string;
}

export interface ActionRecord {
  action: RemediationAction;
  success: boolean;
  summary: string;
  commitUrls?: string[];
  verifyStatus?: VerifyStatus;
  toolTranscript?: ToolTranscriptEntry[];
  at: string;
}

export interface RemediateCommand extends IncidentEnvelope {
  plan: RemediationPlan;
  approvedBy: string;
  approvedAt: string;
  approvedVia: Platform;
  requestedBy?: string;
  platform?: Platform;
  channelId?: string;
  runId?: string;
  /** Runtime options derived from tool registry (e.g. dry-run before apply). */
  executionOptions?: {
    dryRun?: boolean;
  };
}

export interface PendingToolApproval {
  toolIndex: number;
  tool: string;
  requestedAt: string;
}

export interface ApprovalRequest extends IncidentEnvelope {
  plan: RemediationPlan;
  attemptNumber: number;
  circuitBreakerLimit: number;
  escalated: boolean;
  requestedBy?: string;
  platform?: Platform;
  channelId?: string;
  runId?: string;
  /** When set, approval is for a single tool step mid-run (not the whole plan). */
  approvalKind?: 'plan' | 'tool';
  pendingToolApproval?: PendingToolApproval;
}

export interface RemediationResult extends IncidentEnvelope {
  success: boolean;
  gitCommitUrl?: string;
  gitCommitSha?: string;
  appRepoCommitUrl?: string;
  argoCDSyncStatus?: 'Synced' | 'OutOfSync' | 'Degraded' | 'Unknown' | 'Pending';
  argoCDAppUrl?: string;
  dryRunPassed?: boolean;
  error?: string;
  requestedBy?: string;
  platform?: Platform;
  channelId?: string;
  runId?: string;
}

export interface ExecutionResult extends IncidentEnvelope {
  success: boolean;
  method?: string;
  error?: string;
  runId?: string;
}

export interface VerifyResult {
  healthy: boolean;
  readyReplicas?: number;
  desiredReplicas?: number;
  podPhases?: string[];
  recentWarningCount?: number;
  message: string;
}

export interface SanitizeForLlmRequest {
  context?: DiagnosisContext;
  text?: string;
  incidentId: string;
}

export interface SanitizeForLlmResponse {
  sanitized?: SanitizedFacts;
  sanitizedText?: string;
  findings: SecurityFinding[];
  blocked: boolean;
}

export interface AuthorizeActionRequest {
  plan: RemediationPlan;
  namespace: string;
  resourceName: string;
  resourceKind: ResourceKind;
  mode: IncidentMode;
  incidentId: string;
  githubRepo?: string;
}

export interface AuthorizeActionResult {
  allowed: boolean;
  reason: string;
  findings: SecurityFinding[];
  forceHil: boolean;
}

export interface PolicyGateResult {
  autoExecute: boolean;
  reason: string;
}

export interface StartRunRequest extends IncidentEnvelope {
  podName?: string;
  eventReason?: string;
  eventMessage?: string;
  githubRepo?: string;
  gitRef?: string;
  deployStrategy?: 'gitops' | 'direct';
  requestedBy?: string;
  platform?: Platform;
  channelId?: string;
  rawMessage?: string;
}

export interface StartRunResponse {
  runId: string;
  incidentId: string;
  status: RunStatus;
}

export interface ResumeRunRequest {
  runId: string;
  approved: boolean;
  approvedBy: string;
  approvedVia: Platform;
  command?: RemediateCommand;
}

export interface SecurityAuditEvent {
  eventType:
    | 'sanitize_blocked'
    | 'sanitize_redacted'
    | 'authorize_denied'
    | 'authorize_allowed'
    | 'act_executed'
    | 'verify_failed'
    | 'run_escalated';
  incidentId: string;
  runId?: string;
  namespace?: string;
  resourceName?: string;
  action?: RemediationAction;
  message: string;
  timestamp: string;
}

export interface SREIncidentStatus {
  incidentId: string;
  namespace: string;
  resourceKind: ResourceKind;
  resourceName: string;
  attemptCount: number;
  lastAttemptAt: string;
  approvalStatus: ApprovalStatus;
  approvedBy?: string;
  approvedVia?: Platform;
  gitCommitUrl?: string;
  resolvedAt?: string;
  escalated: boolean;
  currentRunId?: string;
  lastVerifyStatus?: VerifyStatus;
  actionHistory?: ActionRecord[];
  autonomyMode?: AutonomyMode;
}

export interface QueuedRequest<T = unknown> {
  id: string;
  targetUrl: string;
  payload: T;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: string;
  createdAt: string;
}

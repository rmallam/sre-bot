// ─────────────────────────────────────────────────────────────────────────────
// Shared payload types for the Kube SRE Microservice Agent Framework
// ─────────────────────────────────────────────────────────────────────────────

import type { RcaPointer } from './rca-pointers.js';
import type { RolloutPhase } from './rollout-phase.js';
import type { DeployProvenance } from './deploy-provenance.js';
export type { RcaPointer, RcaPointerSource } from './rca-pointers.js';
export type { RolloutPhase } from './rollout-phase.js';

export type Platform = 'slack' | 'telegram' | 'teams' | 'web';
export type ResourceKind = 'Deployment' | 'StatefulSet' | 'Pod' | 'Job' | 'DaemonSet';
export type IncidentMode = 'diagnose' | 'pre-deploy' | 'rollback' | 'ci-failure';
export type InvestigateScope = 'workload' | 'namespace' | 'cluster' | 'app';
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
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

export type RemediationAction =
  | 'restart'
  | 'git_patch'
  | 'helm_deploy'
  | 'repo_apply'
  | 'cicd_rerun'
  | 'cicd_open_pr'
  | 'cicd_code_pr'
  | 'coding_agent_handoff'
  | 'escalate_human'
  | 'noop';

export type AutonomyMode = 'full' | 'low_risk_only' | 'hil_all';

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
  githubRepo?: string;
  /** Deploy from a catalog/public image without a Git repository. */
  containerImage?: string;
  gitRef?: string;
  deployStrategy?: 'gitops' | 'direct';
  requestedBy: string;
  platform: Platform;
  channelId: string;
  rawMessage: string;
  /** Multi-service deploy from multiple repositories (single incident / approval). */
  stackServices?: StackServiceRef[];
}

export interface StackServiceRef {
  name: string;
  githubRepo: string;
  gitRef?: string;
}

export interface StackDependencyEdge {
  from: string;
  to: string;
  reason: string;
}

export interface StackServiceAnalysis extends StackServiceRef {
  entryPointKind: 'helm' | 'kustomize' | 'plain-yaml' | 'unknown';
  manifestPath?: string;
  needsHelmGeneration: boolean;
  repoSignals?: RepoSignals;
  resolvedGitRef?: string;
  cloneError?: string;
  dependencies: string[];
}

export interface StackDeployAnalysis {
  stackName: string;
  namespace: string;
  services: StackServiceAnalysis[];
  dependencyEdges: StackDependencyEdge[];
  deploymentOrder: string[];
  hasCycle: boolean;
}

export interface RepoSignals {
  hasDockerfile?: boolean;
  hasPackageJson?: boolean;
  hasGoMod?: boolean;
  primaryLanguage?: string;
  suggestedImage?: string;
  /** Runtime detected for S2I / buildpacks (DEPLOY-2). */
  detectedRuntime?: string;
  needsImageBuild?: boolean;
  buildStrategy?: 'existing-dockerfile' | 'buildpacks' | 's2i' | 'skip';
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
  repoEntryPointKind?: 'helm' | 'kustomize' | 'plain-yaml' | 'operator-install' | 'unknown';
  repoSignals?: RepoSignals;
  priorActionSummary?: string;
  safeMode?: boolean;
  /** Git ref actually cloned when it differed from the request (e.g. default branch fallback). */
  resolvedGitRef?: string;
  /** Set when repo clone failed after all ref fallbacks. */
  cloneError?: string;
  /** README.md content from cloned deploy repo (pre-deploy). */
  gitReadmeContent?: string;
  /** Enterprise scenario selected by deploy planner (audit). */
  enterpriseScenario?: string;
  /** Optional analysis for multi-repo deploy runs. */
  stackDeploy?: StackDeployAnalysis;
  /** Parallel specialist summaries (workload/network/database). */
  specialistDiagnostics?: SpecialistDiagnostic[];
  /** Official runbook markdown from platform RAG (grounding). */
  retrievedPlaybook?: string;
  /** Detected K8s error signature for RAG lookup. */
  detectedErrorSignature?: string;
  /** RAG metadata filter component (compute|storage|network|gitops). */
  targetComponent?: string;
  /** Multi-source RCA evidence (K8s, Loki, Prometheus, …). */
  rcaPointers?: RcaPointer[];
  /** One-paragraph merge of top RCA pointers for planners. */
  observabilitySummary?: string;
  /** False when the Kubernetes API is unreachable or returned no nodes. */
  clusterReachable?: boolean;
  /** Populated in ci-failure mode from cicd-agent. */
  ciRun?: CiRunFacts;
  /** How this workload was deployed — drives fix routing. */
  deployProvenance?: DeployProvenance;
}

export interface SpecialistDiagnostic {
  specialist: 'workload' | 'network' | 'database';
  summary: string;
  confidence: number;
  findings: string[];
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

import type { PatchTarget } from './patch-target.js';
import type { CiRunFacts } from './ci-types.js';
import type { CiFixCategory } from './ci-types.js';
export type { PatchTarget };

export interface CiCodePatch {
  path: string;
  content: string;
}

export interface RemediationPlanCicdMeta {
  workflowRunId: number;
  workflowName: string;
  fixCategory?: CiFixCategory;
  workflowFilePath?: string;
  prTitle?: string;
  prBody?: string;
  logExcerpt?: string;
  codePatches?: CiCodePatch[];
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
  /** cluster = live API patch only; gitops = mirror/Argo only; auto = env + fallback rules */
  patchTarget?: PatchTarget;
  helmChart?: HelmChartPayload;
  targetRepo?: 'app' | 'gitops' | 'both';
  githubRepo?: string;
  gitRef?: string;
  cicd?: RemediationPlanCicdMeta;
  /** Enterprise deploy scenario selected by planner (audit). */
  enterpriseScenario?: string;
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
    /** User approved creating the target namespace before apply. */
    createNamespace?: boolean;
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
  /** Operator-provided fix text (replaces or refines bot plan). */
  humanSuggestion?: string;
  planSource?: 'bot' | 'human';
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
  /** Apps/v1 status.updatedReplicas — rollout progress. */
  updatedReplicas?: number;
  /** True when replicas are still converging (not a terminal pod error). */
  rolloutInProgress?: boolean;
  /** What the cluster is doing during rollout (image pull, probes, etc.). */
  rolloutPhase?: RolloutPhase;
  /** Operator-facing detail, e.g. "2 pods pulling ghcr.io/org/app:v2". */
  waitDetail?: string;
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
  investigateScope?: InvestigateScope;
  investigationLabel?: string;
  githubRepo?: string;
  gitRef?: string;
  deployStrategy?: 'gitops' | 'direct';
  /** Public image deploy (e.g. httpd:2.4-alpine) when no githubRepo. */
  containerImage?: string;
  requestedBy?: string;
  platform?: Platform;
  channelId?: string;
  rawMessage?: string;
  /** User confirmed namespace should be created if missing. */
  createNamespace?: boolean;
  /** Multi-service deploy request with one incident lifecycle. */
  stackServices?: StackServiceRef[];
  /** CI/CD: specific workflow run (GitHub Actions). */
  workflowRunId?: number;
  workflowName?: string;
  prNumber?: number;
  ciBranch?: string;
  /** AGENT-1 — durable case thread id (commander-managed). */
  caseId?: string;
  /** Override global SRE_AGENT_MODE for this run. */
  agentMode?: 'classic' | 'agentic';
  /** Merged user hints from case evidence. */
  userHints?: string[];
  /** User- or registry-provided deploy provenance for fix routing. */
  deployProvenance?: Partial<DeployProvenance>;
  /** Allow temporary cluster-only patch when Git source is unknown. */
  allowClusterHotFix?: boolean;
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

// ── Failure analyst (orchestrator → brain after act failure) ─────────────────

export type FailureDecision = 'retry_with_plan' | 'escalate_human' | 'stop_noop';

export interface FailureAnalysisRequest {
  incidentId: string;
  mode: IncidentMode;
  namespace: string;
  resourceName: string;
  resourceKind: ResourceKind;
  failedAction: RemediationAction;
  errorMessage: string;
  failureKind: string;
  alternateStrategyMayHelp: boolean;
  actionHistorySummary: string;
  facts: SanitizedFacts;
  githubRepo?: string;
  gitRef?: string;
  deployStrategy?: 'gitops' | 'direct';
}

export interface FailureAnalysisResult {
  decision: FailureDecision;
  reasoning: string;
  /** Short message for Telegram/Slack progress */
  operatorMessage: string;
  confidence: number;
  /**
   * Optional proposal from LLM/deterministic analyst when the root cause is a
   * missing resource that could be created after user approval.
   */
  missingResource?: {
    kind: 'namespace' | 'configmap' | 'secret' | 'serviceaccount' | 'crd' | 'other';
    name: string;
    namespace?: string;
    reason: string;
    canAutoCreate: boolean;
    createAction?: 'create_namespace';
  };
  suggestedAction?: RemediationAction;
  suggestedGitRef?: string;
  deployStrategy?: 'gitops' | 'direct';
  rootCause?: string;
}

export interface PlanValidationIssue {
  code: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  message: string;
  path?: string;
}

export interface PlanValidationRequest {
  incidentId: string;
  namespace: string;
  mode: IncidentMode;
  resourceKind: ResourceKind;
  resourceName: string;
  facts?: Partial<DiagnosisContext>;
  plan: RemediationPlan;
}

export interface PlanValidationResult {
  allowed: boolean;
  requiresHumanApproval: boolean;
  issues: PlanValidationIssue[];
  summary: string;
}

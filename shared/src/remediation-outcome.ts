/**
 * Remediation outcomes — structured record of suggested fix, result, and follow-up.
 * Intended for console display and future skill compilation.
 */

import type { StoredRun } from './run-persistence.js';
import type {
  ActionRecord,
  RemediationPlan,
  RunStatus,
  ToolTranscriptEntry,
} from './types.js';
import { actionOutcomeLabel, runStatusOutcomeLabel } from './user-outcomes.js';
import { formatSuggestedActionLabel, isStaleRunningRun } from './stale-run.js';

export type HumanDecision = 'approved' | 'rejected' | 'ignored' | 'auto' | 'pending';

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
  /** true = verified healthy / succeeded; false = failed; null = in progress or unknown */
  worked: boolean | null;
  finalStatus: RunStatus;
  humanDecision?: HumanDecision;
  actionsTaken: RemediationActionTaken[];
  followUp?: string;
  recordedAt: string;
  /** One-line summary for skill indexes */
  skillSummary: string;
}

export interface EnrichedRunSummary {
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
  resourceKey: string;
  displayName: string;
  outcome?: RemediationOutcome;
  /** True when a running row looks orphaned (no recent progress). */
  isStale?: boolean;
  /** Human-readable suggested fix label for console display. */
  suggestedActionLabel?: string;
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
  runs: EnrichedRunSummary[];
}

export function resourceKeyFromStartRequest(req: {
  githubRepo?: string;
  namespace?: string;
  resourceName?: string;
  incidentId?: string;
}): string {
  if (req.githubRepo) return `ci:${req.githubRepo}`;
  if (req.namespace && req.resourceName) return `k8s:${req.namespace}/${req.resourceName}`;
  return `run:${req.incidentId ?? 'unknown'}`;
}

export function runResourceKey(run: StoredRun): string {
  const req = run.metadata?.request as Record<string, unknown> | undefined;
  if (req?.githubRepo) return `ci:${String(req.githubRepo)}`;
  if (req?.namespace && req?.resourceName) {
    return `k8s:${String(req.namespace)}/${String(req.resourceName)}`;
  }
  return `run:${run.runId}`;
}

export function runDisplayName(run: StoredRun): string {
  const req = run.metadata?.request as Record<string, unknown> | undefined;
  if (req?.githubRepo) return String(req.githubRepo);
  if (req?.namespace && req?.resourceName) {
    return `${String(req.namespace)}/${String(req.resourceName)}`;
  }
  return run.runId.slice(0, 8);
}

export function isNoopInvestigationOutcome(
  status: RunStatus,
  suggestedAction: string | undefined
): boolean {
  return status === 'succeeded' && suggestedAction === 'noop';
}

const NOOP_ACTION_ARTIFACT_SUMMARIES = [
  'No tool calls in capability plan',
  'No operation required',
  'No executable tool mapping for plan action',
];

export function isNoopActionArtifact(action: RemediationActionTaken): boolean {
  if (action.action !== 'noop') return false;
  const summary = action.summary?.trim() ?? '';
  if (!summary) return true;
  return NOOP_ACTION_ARTIFACT_SUMMARIES.some((s) => summary.includes(s));
}

export function filterDisplayActionsTaken(
  plan: RemediationPlan | undefined,
  actionsTaken: RemediationActionTaken[]
): RemediationActionTaken[] {
  if (plan?.action === 'noop') return [];
  return actionsTaken.filter((a) => !isNoopActionArtifact(a));
}

export function noopOutcomeLabel(): string {
  return 'No action taken';
}

export function inferOutcomeWorkedLabel(
  worked: boolean | null,
  status: RunStatus,
  suggestedAction: string | undefined
): string {
  if (isNoopInvestigationOutcome(status, suggestedAction)) return noopOutcomeLabel();
  if (worked === true) return 'Worked';
  if (worked === false) return 'Did not work';
  return 'Pending';
}

export function buildRemediationOutcome(params: {
  run: StoredRun;
  status: RunStatus;
  lastError?: string;
  actionHistory?: ActionRecord[];
  plan?: RemediationPlan;
  humanDecision?: HumanDecision;
}): RemediationOutcome {
  const { run, status, lastError, actionHistory = [], plan, humanDecision } = params;
  const resourceKey = runResourceKey(run);
  const suggestedAction = plan?.action ?? inferActionFromHistory(actionHistory) ?? 'unknown';
  const rawActionsTaken = actionHistory.map((a) => ({
    action: a.action,
    success: a.success,
    summary: a.summary,
    verifyStatus: a.verifyStatus,
    commitUrls: a.commitUrls,
    at: a.at,
  }));
  const actionsTaken = filterDisplayActionsTaken(plan, rawActionsTaken);

  const worked = inferWorked(status, actionHistory, humanDecision, suggestedAction);
  const followUp = buildFollowUp(status, lastError, actionHistory, humanDecision, suggestedAction);

  const skillSummary = [
    plan?.rootCause?.slice(0, 80) ?? 'incident',
    '→',
    actionOutcomeLabel(suggestedAction as RemediationPlan['action']),
    isNoopInvestigationOutcome(status, suggestedAction)
      ? '(no action)'
      : worked === true
        ? '(worked)'
        : worked === false
          ? '(failed)'
          : '(pending)',
  ].join(' ');

  return {
    resourceKey,
    suggestedAction,
    rootCause: plan?.rootCause,
    reasoning: plan?.reasoning,
    severity: plan?.severity,
    planSource: (run.metadata?.planSource as 'bot' | 'human' | undefined),
    worked,
    finalStatus: status,
    humanDecision,
    actionsTaken,
    followUp,
    recordedAt: new Date().toISOString(),
    skillSummary,
  };
}

function inferActionFromHistory(history: ActionRecord[]): string | undefined {
  const last = history[history.length - 1];
  return last?.action;
}

function inferWorked(
  status: RunStatus,
  history: ActionRecord[],
  humanDecision?: HumanDecision,
  suggestedAction?: string
): boolean | null {
  if (humanDecision === 'rejected' || humanDecision === 'ignored') return false;
  if (status === 'running' || status === 'awaiting_human' || status === 'pending_throttled') return null;
  if (status === 'cancelled') return null;
  if (isNoopInvestigationOutcome(status, suggestedAction)) return null;
  if (status === 'succeeded') {
    const last = [...history].reverse().find((a) => a.action !== 'noop');
    if (!last) return true;
    if (last.verifyStatus === 'degraded') return false;
    return last.success;
  }
  if (status === 'failed' || status === 'escalated') return false;
  return null;
}

function buildFollowUp(
  status: RunStatus,
  lastError: string | undefined,
  history: ActionRecord[],
  humanDecision?: HumanDecision,
  suggestedAction?: string
): string | undefined {
  if (humanDecision === 'rejected') return 'Operator rejected the suggested remediation.';
  if (humanDecision === 'ignored') return 'Resource added to ignore list — no remediation attempted.';
  if (isNoopInvestigationOutcome(status, suggestedAction)) {
    return 'Investigation completed — no automated fix was recommended.';
  }
  if (lastError && !isNoopCapabilityArtifactError(lastError)) return lastError;
  const last = history[history.length - 1];
  if (status === 'succeeded' && last?.summary && !isNoopActionArtifact({
    action: last.action,
    success: last.success,
    summary: last.summary,
  })) {
    return last.summary;
  }
  if (status === 'awaiting_human') return 'Waiting for operator approval before applying the fix.';
  if (status === 'pending_throttled') {
    return 'Queued — waiting for other remediations in this namespace to finish.';
  }
  return runStatusOutcomeLabel(status);
}

function isNoopCapabilityArtifactError(message: string): boolean {
  return NOOP_ACTION_ARTIFACT_SUMMARIES.some((s) => message.includes(s));
}

const GENERIC_CAPABILITY_ROOT_CAUSE = 'Capability planner selected tool pipeline';

function preferDisplayRootCause(
  stored?: string,
  plan?: string,
  fresh?: string
): string | undefined {
  const candidates = [stored, plan, fresh].filter(Boolean) as string[];
  for (const c of candidates) {
    if (c.trim() !== GENERIC_CAPABILITY_ROOT_CAUSE) return c;
  }
  return candidates[0];
}

/** Best-effort outcome for runs recorded before outcome persistence. */
export function deriveOutcomeFromStoredRun(run: StoredRun): RemediationOutcome {
  const stored = run.metadata?.remediationOutcome as RemediationOutcome | undefined;
  const plan = run.metadata?.remediationPlan as RemediationPlan | undefined;
  const history = transcriptToActionHistory(run.transcript);
  const humanDecision = run.metadata?.humanDecision as HumanDecision | undefined;

  const fresh = buildRemediationOutcome({
    run,
    status: run.status,
    lastError: run.metadata?.lastError as string | undefined,
    actionHistory: history,
    plan,
    humanDecision,
  });

  if (!stored?.recordedAt) return fresh;

  // Re-normalize display fields so console UX fixes apply to persisted outcomes too.
  return {
    ...stored,
    worked: fresh.worked,
    actionsTaken: fresh.actionsTaken,
    followUp: fresh.followUp,
    skillSummary: fresh.skillSummary,
    rootCause: preferDisplayRootCause(stored.rootCause, plan?.rootCause, fresh.rootCause),
    reasoning: stored.reasoning ?? plan?.reasoning ?? fresh.reasoning,
  };
}

function transcriptToActionHistory(transcript: ToolTranscriptEntry[]): ActionRecord[] {
  return transcript
    .filter((e) => e.tool && !e.tool.includes('investigator') && !e.tool.includes('security'))
    .map((e) => ({
      action: inferActionFromTool(String(e.tool)),
      success: e.success !== false,
      summary: e.summary ?? e.error ?? String(e.tool),
      at: e.at,
    }));
}

function inferActionFromTool(tool: string): ActionRecord['action'] {
  if (tool.includes('restart')) return 'restart';
  if (tool.includes('gitops') || tool.includes('patch')) return 'git_patch';
  if (tool.includes('helm')) return 'helm_deploy';
  if (tool.includes('cicd')) return 'cicd_rerun';
  return 'noop';
}

export function enrichStoredRun(run: StoredRun): EnrichedRunSummary {
  const req = run.metadata?.request as Record<string, unknown> | undefined;
  const mode = (run.metadata?.mode as string | undefined) ?? (req?.mode as string | undefined);
  const toolCount = run.transcript.length;
  const isStale = isStaleRunningRun({
    status: run.status,
    transcript: run.transcript,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt,
  });
  const outcome = deriveOutcomeFromStoredRun(run);
  const followUp =
    isStale && run.status === 'running'
      ? 'Run appears orphaned (orchestrator may have restarted). Cancel and retry from chat.'
      : outcome.followUp;

  return {
    runId: run.runId,
    incidentId: run.incidentId,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    toolCount,
    mode,
    namespace: req?.namespace as string | undefined,
    resourceName: req?.resourceName as string | undefined,
    githubRepo: req?.githubRepo as string | undefined,
    resourceKey: runResourceKey(run),
    displayName: runDisplayName(run),
    outcome: followUp !== outcome.followUp ? { ...outcome, followUp } : outcome,
    isStale,
    suggestedActionLabel: formatSuggestedActionLabel(outcome.suggestedAction, {
      status: run.status,
      toolCount,
      isStale,
    }),
  };
}

export function groupRunsByResource(runs: EnrichedRunSummary[]): ResourceRunGroup[] {
  const map = new Map<string, ResourceRunGroup>();

  for (const run of runs) {
    let group = map.get(run.resourceKey);
    if (!group) {
      const kind: ResourceRunGroup['kind'] = run.resourceKey.startsWith('ci:')
        ? 'ci'
        : run.resourceKey.startsWith('k8s:')
          ? 'k8s'
          : 'unknown';
      group = {
        resourceKey: run.resourceKey,
        displayName: run.displayName,
        kind,
        namespace: run.namespace,
        resourceName: run.resourceName,
        githubRepo: run.githubRepo,
        latestStatus: run.status,
        attemptCount: 0,
        successCount: 0,
        lastUpdated: run.updatedAt,
        runs: [],
      };
      map.set(run.resourceKey, group);
    }
    group.runs.push(run);
    group.attemptCount += 1;
    if (run.outcome?.worked === true) group.successCount += 1;
    if (run.updatedAt > group.lastUpdated) {
      group.lastUpdated = run.updatedAt;
      group.latestStatus = run.status;
    }
  }

  for (const group of map.values()) {
    group.runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  return [...map.values()].sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
}

/** Markdown fragment suitable for skills/ runbooks compilation. */
export function formatSkillMarkdown(
  run: EnrichedRunSummary,
  resourceLabel?: string
): string {
  const o = run.outcome;
  if (!o) return '';

  const title = resourceLabel ?? run.displayName;
  const lines: string[] = [
    `### ${title} — ${new Date(run.updatedAt).toISOString().slice(0, 10)}`,
    '',
    `**Trigger:** ${run.mode?.replace(/-/g, ' ') ?? 'task'} (${run.incidentId.slice(0, 8)})`,
  ];

  if (o.rootCause) lines.push(`**Root cause:** ${o.rootCause}`);
  lines.push(
    `**Suggested fix:** ${actionOutcomeLabel(o.suggestedAction as RemediationPlan['action'])}`
  );
  if (o.reasoning) lines.push(`**Reasoning:** ${o.reasoning}`);
  if (o.severity) lines.push(`**Severity:** ${o.severity}`);

  const workedLabel = isNoopInvestigationOutcome(o.finalStatus, o.suggestedAction)
    ? noopOutcomeLabel()
    : o.worked === true
      ? 'Yes — verified / succeeded'
      : o.worked === false
        ? 'No'
        : 'Pending / unknown';
  lines.push(`**Outcome:** ${workedLabel}`);

  if (o.actionsTaken.length) {
    lines.push('', '**Actions taken:**');
    for (const a of o.actionsTaken) {
      const mark = a.success ? '✓' : '✗';
      lines.push(`- ${mark} ${actionOutcomeLabel(a.action as RemediationPlan['action'])}: ${a.summary.slice(0, 240)}`);
    }
  }

  if (o.followUp) lines.push('', `**Follow-up:** ${o.followUp.slice(0, 500)}`);

  lines.push('', `<!-- runId: ${run.runId} -->`, '');
  return lines.join('\n');
}

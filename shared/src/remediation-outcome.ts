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
  const actionsTaken = actionHistory.map((a) => ({
    action: a.action,
    success: a.success,
    summary: a.summary,
    verifyStatus: a.verifyStatus,
    commitUrls: a.commitUrls,
    at: a.at,
  }));

  const worked = inferWorked(status, actionHistory, humanDecision);
  const followUp = buildFollowUp(status, lastError, actionHistory, humanDecision);

  const skillSummary = [
    plan?.rootCause?.slice(0, 80) ?? 'incident',
    '→',
    actionOutcomeLabel(suggestedAction as RemediationPlan['action']),
    worked === true ? '(worked)' : worked === false ? '(failed)' : '(pending)',
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
  humanDecision?: HumanDecision
): boolean | null {
  if (humanDecision === 'rejected' || humanDecision === 'ignored') return false;
  if (status === 'running' || status === 'awaiting_human') return null;
  if (status === 'cancelled') return null;
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
  humanDecision?: HumanDecision
): string | undefined {
  if (humanDecision === 'rejected') return 'Operator rejected the suggested remediation.';
  if (humanDecision === 'ignored') return 'Resource added to ignore list — no remediation attempted.';
  if (lastError) return lastError;
  const last = history[history.length - 1];
  if (status === 'succeeded' && last?.summary) return last.summary;
  if (status === 'awaiting_human') return 'Waiting for operator approval before applying the fix.';
  return runStatusOutcomeLabel(status);
}

/** Best-effort outcome for runs recorded before outcome persistence. */
export function deriveOutcomeFromStoredRun(run: StoredRun): RemediationOutcome {
  const stored = run.metadata?.remediationOutcome as RemediationOutcome | undefined;
  if (stored?.recordedAt) return stored;

  const plan = run.metadata?.remediationPlan as RemediationPlan | undefined;
  const history = transcriptToActionHistory(run.transcript);
  const humanDecision = run.metadata?.humanDecision as HumanDecision | undefined;

  return buildRemediationOutcome({
    run,
    status: run.status,
    lastError: run.metadata?.lastError as string | undefined,
    actionHistory: history,
    plan,
    humanDecision,
  });
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
  return {
    runId: run.runId,
    incidentId: run.incidentId,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    toolCount: run.transcript.length,
    mode,
    namespace: req?.namespace as string | undefined,
    resourceName: req?.resourceName as string | undefined,
    githubRepo: req?.githubRepo as string | undefined,
    resourceKey: runResourceKey(run),
    displayName: runDisplayName(run),
    outcome: deriveOutcomeFromStoredRun(run),
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
    if (run.outcome?.worked === true || run.status === 'succeeded') group.successCount += 1;
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

  const workedLabel =
    o.worked === true ? 'Yes — verified / succeeded' : o.worked === false ? 'No' : 'Pending / unknown';
  lines.push(`**Worked:** ${workedLabel}`);

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

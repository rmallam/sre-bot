/**
 * UX-4 — User-friendly run summaries from orchestrator transcripts.
 */

import type { CiRunFacts } from './ci-types.js';
import type { StoredRun } from './run-persistence.js';
import { runStatusOutcomeLabel, sanitizeUserFacingText } from './user-outcomes.js';
import {
  formatToolDisplayLabel,
  formatToolSummaryDetail,
} from './tool-user-labels.js';
import { formatRunEndState } from './run-end-state.js';

export interface RunSummaryOptions {
  /** Include log excerpts (verbose). Default true for detail view. */
  includeLogs?: boolean;
  maxLogLines?: number;
}

export function formatRunSummaryForUser(
  run: StoredRun,
  opts?: RunSummaryOptions
): string {
  const includeLogs = opts?.includeLogs ?? true;
  const maxLogLines = opts?.maxLogLines ?? 12;
  const mode = (run.metadata?.mode as string | undefined) ?? 'task';
  const request = run.metadata?.request as Record<string, unknown> | undefined;
  const lines: string[] = [];

  lines.push(
    `Run ${run.runId.slice(0, 8)} — ${runStatusOutcomeLabel(run.status)}.`
  );

  if (mode === 'ci-failure' && request?.githubRepo) {
    lines.push(`Repo: ${request.githubRepo}`);
  } else if (request?.namespace && request?.resourceName) {
    lines.push(`Target: ${request.namespace}/${request.resourceName}`);
  }

  const ciRun = extractCiRunFromRun(run);
  if (ciRun?.diagnosis?.summary) {
    lines.push('', ciRun.diagnosis.summary);
    if (ciRun.diagnosis.userGuidance) {
      lines.push(ciRun.diagnosis.userGuidance);
    }
    if (includeLogs && ciRun.diagnosis.errorHighlight?.length) {
      lines.push('', 'Log excerpt:');
      lines.push(
        ciRun.diagnosis.errorHighlight.slice(-maxLogLines).join('\n').slice(0, 2000)
      );
    } else if (includeLogs && ciRun.logExcerpt) {
      const logLines = ciRun.logExcerpt.split('\n').filter(Boolean).slice(-maxLogLines);
      if (logLines.length) {
        lines.push('', 'Log excerpt:');
        lines.push(logLines.join('\n').slice(0, 2000));
      }
    }
  }

  const prUrl = extractPrUrlFromTranscript(run);
  if (prUrl) {
    lines.push('', `PR: ${prUrl}`);
  }

  const planAction = (run.metadata?.remediationPlan as { action?: string } | undefined)?.action;

  const recentSteps = run.transcript
    .slice(-5)
    .map((e) => {
      const label = formatToolDisplayLabel(e.tool, planAction);
      const detail = formatToolSummaryDetail(e.tool, e.summary, planAction);
      return detail ? `${label} — ${detail}` : label;
    })
    .filter(Boolean)
    .map((s) => sanitizeUserFacingText(String(s)));

  if (recentSteps.length && !ciRun?.diagnosis) {
    lines.push('', 'What happened:');
    for (const step of recentSteps) {
      lines.push(`• ${step.slice(0, 240)}`);
    }
  }

  const endState = formatRunEndState(run);
  if (endState) {
    lines.push('', endState.replace(/\*\*/g, ''));
  }

  return lines.join('\n').slice(0, 4500);
}

function extractCiRunFromRun(run: StoredRun): CiRunFacts | undefined {
  const fromMeta = run.metadata?.ciRun as CiRunFacts | undefined;
  if (fromMeta) return fromMeta;

  const req = run.metadata?.request as Record<string, unknown> | undefined;
  if (req?.githubRepo) {
    return {
      githubRepo: String(req.githubRepo),
      workflowRunId: Number(req.workflowRunId ?? 0),
      workflowName: String(req.workflowName ?? 'workflow'),
      branch: String(req.ciBranch ?? 'main'),
      headSha: '',
      status: 'completed',
      conclusion: null,
      htmlUrl: '',
      event: 'workflow_dispatch',
      failedJobs: [],
    };
  }
  return undefined;
}

function extractPrUrlFromTranscript(run: StoredRun): string | undefined {
  for (const entry of [...run.transcript].reverse()) {
    const summary = entry.summary ?? '';
    const match = summary.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
    if (match) return match[0];
  }
  return undefined;
}

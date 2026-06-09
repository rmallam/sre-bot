/**
 * Evidence accumulation helpers for agentic investigate loop.
 */

import type { DiagnosisContext, StartRunRequest } from './types.js';
import type { AgentStepRecord } from './agent-read-tools.js';

export function mergeAgentEvidence(
  base: Partial<DiagnosisContext>,
  chunk: Partial<DiagnosisContext> | Record<string, unknown>
): Partial<DiagnosisContext> {
  const c = chunk as Partial<DiagnosisContext>;
  return {
    ...base,
    ...c,
    recentEvents: c.recentEvents?.length ? c.recentEvents : base.recentEvents,
    containerStatuses: c.containerStatuses?.length ? c.containerStatuses : base.containerStatuses,
    currentLogs: c.currentLogs?.trim() ? c.currentLogs : base.currentLogs,
    previousLogs: c.previousLogs?.trim() ? c.previousLogs : base.previousLogs,
    observabilitySummary: c.observabilitySummary?.trim()
      ? c.observabilitySummary
      : base.observabilitySummary,
    specialistDiagnostics: c.specialistDiagnostics?.length
      ? c.specialistDiagnostics
      : base.specialistDiagnostics,
    detectedErrorSignature: c.detectedErrorSignature ?? base.detectedErrorSignature,
  };
}

export function buildAgentGoal(request: StartRunRequest, focus?: string): string {
  const hints = request.userHints?.length
    ? ` User hints: ${request.userHints.join('; ')}`
    : '';
  const focusNote = focus ? ` Focus: ${focus}.` : '';
  return (
    `Investigate ${request.namespace}/${request.resourceName} (${request.mode}).` +
    (request.eventMessage ? ` Context: ${request.eventMessage}.` : '') +
    hints +
    focusNote
  );
}

export function evidenceSummaryForLlm(evidence: Partial<DiagnosisContext>): string {
  const lines: string[] = [];
  const statuses = evidence.containerStatuses ?? [];
  if (statuses.length) {
    for (const s of statuses.slice(0, 4)) {
      const st = s as {
        name?: string;
        state?: { waiting?: { reason?: string }; terminated?: { reason?: string } };
        restartCount?: number;
      };
      const wait = st.state?.waiting?.reason;
      const term = st.state?.terminated?.reason;
      lines.push(
        `container ${st.name ?? '?'}: waiting=${wait ?? '-'} terminated=${term ?? '-'} restarts=${st.restartCount ?? 0}`
      );
    }
  }
  const events = evidence.recentEvents ?? [];
  if (events.length) {
    lines.push('recent events:');
    for (const e of events.slice(0, 6)) {
      lines.push(`  - ${e.reason}: ${e.message.slice(0, 160)}`);
    }
  }
  if (evidence.currentLogs?.trim()) {
    lines.push(`log excerpt (${evidence.currentLogs.split('\n').length} lines):`);
    lines.push(evidence.currentLogs.slice(0, 1500));
  }
  if (evidence.observabilitySummary?.trim()) {
    lines.push(`metrics/logs summary: ${evidence.observabilitySummary.slice(0, 800)}`);
  }
  return lines.length ? lines.join('\n') : 'No evidence gathered yet.';
}

export function agentEvidenceToDiagnosisContext(
  request: StartRunRequest,
  evidence: Partial<DiagnosisContext>,
  steps: AgentStepRecord[]
): DiagnosisContext {
  return {
    incidentId: request.incidentId,
    triggeredBy: request.triggeredBy,
    triggeredAt: request.triggeredAt,
    mode: request.mode,
    namespace: request.namespace,
    resourceName: request.resourceName,
    resourceKind: request.resourceKind,
    recentEvents: evidence.recentEvents ?? [],
    currentLogs: evidence.currentLogs ?? '',
    previousLogs: evidence.previousLogs ?? '',
    podSpec: evidence.podSpec ?? {},
    containerStatuses: evidence.containerStatuses ?? [],
    resourceLimits: evidence.resourceLimits ?? {},
    observabilitySummary: evidence.observabilitySummary,
    specialistDiagnostics: evidence.specialistDiagnostics,
    githubRepo: evidence.githubRepo ?? request.githubRepo,
    platform: request.platform,
    channelId: request.channelId,
    priorActionSummary:
      steps.length > 0
        ? `agent_react_steps=${steps.map((s) => `${s.tool}:${s.summary.slice(0, 40)}`).join('|')}`
        : undefined,
    detectedErrorSignature: evidence.detectedErrorSignature,
  };
}

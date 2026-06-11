/**
 * AGENT-D2/D3 — Sync case state from orchestrator runs and persist evidence cache.
 */

import type { Platform, RunStatus } from '../../../shared/src/types.js';
import type { RunUpdatePayload } from '../../../shared/src/run-update.js';
import { mergeCaseEvidenceFromDiagnosis } from '../../../shared/src/agent-case.js';
import { log } from '../../../shared/src/http.js';
import { agentFetch } from './agent-fetch.js';
import {
  getActiveCase,
  syncCaseFromRunOutcome,
  updateCaseStatus,
} from './case-manager.js';
import { getCaseStore } from './case-store.js';

const AGENT = 'commander-case-sync';
const ORCHESTRATOR_URL = process.env['ORCHESTRATOR_URL'] ?? 'http://orchestrator-agent:8080';

const TERMINAL: RunStatus[] = ['succeeded', 'failed', 'escalated', 'cancelled'];

function defaultUserId(platform: Platform): string {
  return platform === 'web' ? 'console' : 'default';
}

export interface ActiveRunLookup {
  active: boolean;
  incidentId?: string;
  runId?: string;
  status?: RunStatus;
}

export async function lookupActiveRun(incidentId: string): Promise<ActiveRunLookup> {
  try {
    const res = await agentFetch(
      `${ORCHESTRATOR_URL}/runs?incidentId=${encodeURIComponent(incidentId)}&limit=1`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return { active: false };
    const data = (await res.json()) as {
      runs?: Array<{ runId: string; incidentId: string; status: RunStatus }>;
    };
    const run = data.runs?.[0];
    if (!run) return { active: false };
    const active = run.status === 'running' || run.status === 'awaiting_human';
    return {
      active,
      incidentId: run.incidentId,
      runId: run.runId,
      status: run.status,
    };
  } catch {
    return { active: false };
  }
}

/** AGENT-D3 — return in-flight run for an open case before starting a duplicate. */
export async function findActiveRunForCase(
  platform: Platform,
  channelId: string,
  userId: string,
  caseId: string
): Promise<ActiveRunLookup | null> {
  const store = getCaseStore();
  const agentCase = await store.get({ platform, channelId, userId, caseId });
  if (!agentCase?.lastIncidentId) return null;
  if (['resolved'].includes(agentCase.status)) return null;

  const lookup = await lookupActiveRun(agentCase.lastIncidentId);
  if (!lookup.active) return null;
  return lookup;
}

export async function persistCaseEvidenceFromRun(
  platform: Platform,
  channelId: string,
  userId: string,
  caseId: string,
  incidentId: string
): Promise<void> {
  try {
    const res = await agentFetch(`${ORCHESTRATOR_URL}/runs?incidentId=${encodeURIComponent(incidentId)}&limit=1`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as {
      runs?: Array<{
        transcript?: Array<{ tool?: string }>;
        metadata?: { remediationPlan?: unknown; ragContext?: Record<string, unknown> };
        outcome?: { rootCause?: string };
      }>;
    };
    const run = data.runs?.[0];
    if (!run) return;

    const store = getCaseStore();
    const agentCase = await store.get({ platform, channelId, userId, caseId });
    if (!agentCase) return;

    const toolNames = (run.transcript ?? [])
      .map((t) => String(t.tool ?? ''))
      .filter(Boolean);
    const rag = run.metadata?.ragContext as { detectedError?: string; targetComponent?: string } | undefined;
    const factsPatch = rag?.detectedError
      ? { detectedErrorSignature: rag.detectedError, targetComponent: rag.targetComponent }
      : {};

    const evidence = mergeCaseEvidenceFromDiagnosis(agentCase.evidence, factsPatch, toolNames);
    await updateCaseStatus(platform, channelId, userId, caseId, agentCase.status, { evidence });
  } catch (err) {
    log('debug', AGENT, 'Case evidence persist skipped', { caseId, error: String(err) });
  }
}

const TERMINAL_UPDATE_KINDS = new Set([
  'run_succeeded',
  'run_failed',
  'run_escalated',
  'deploy_failed',
  'ci_pr_verify_failed',
]);

const STATUS_FROM_KIND: Partial<Record<string, RunStatus>> = {
  run_succeeded: 'succeeded',
  run_failed: 'failed',
  run_escalated: 'escalated',
  deploy_failed: 'failed',
  ci_pr_verify_failed: 'failed',
  ci_pr_verify_succeeded: 'succeeded',
};

export async function onRunUpdateForCase(
  platform: Platform,
  channelId: string,
  update: RunUpdatePayload
): Promise<void> {
  const userId = defaultUserId(platform);
  const agentCase = await getActiveCase(platform, channelId, userId);
  if (!agentCase) return;
  if (update.incidentId && agentCase.lastIncidentId && update.incidentId !== agentCase.lastIncidentId) {
    return;
  }

  const runStatus = STATUS_FROM_KIND[update.kind ?? ''];
  if (runStatus && TERMINAL.includes(runStatus)) {
    await syncCaseFromRunOutcome({
      platform,
      channelId,
      userId,
      caseId: agentCase.caseId,
      runStatus,
      incidentId: update.incidentId,
      runId: update.runId,
    });
    await persistCaseEvidenceFromRun(
      platform,
      channelId,
      userId,
      agentCase.caseId,
      update.incidentId
    );
    return;
  }

  if (update.kind === 'agent_step' && update.incidentId) {
    await persistCaseEvidenceFromRun(
      platform,
      channelId,
      userId,
      agentCase.caseId,
      update.incidentId
    );
  }

  if (update.kind && TERMINAL_UPDATE_KINDS.has(update.kind) && update.incidentId) {
    const status = STATUS_FROM_KIND[update.kind];
    if (status) {
      await syncCaseFromRunOutcome({
        platform,
        channelId,
        userId,
        caseId: agentCase.caseId,
        runStatus: status,
        incidentId: update.incidentId,
        runId: update.runId,
      });
    }
  }
}

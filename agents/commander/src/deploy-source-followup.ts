/**
 * Resume investigate runs after operator provides deploy source details.
 */

import type { Platform } from '../../../shared/src/types.js';
import type { ParsedCommand } from './parser.js';
import { parseDeploySourceReply } from '../../../shared/src/deploy-source-parse.js';
import { mergeDeployProvenance } from '../../../shared/src/deploy-provenance.js';
import { clearPendingClarification, setPendingClarification } from './clarification.js';
import { getSession } from './sessions.js';
import { cancelRun } from './deploy-source-run.js';

const ORCHESTRATOR_URL = process.env['ORCHESTRATOR_URL'] ?? 'http://orchestrator-agent:8080';

export async function armDeploySourceClarification(
  platform: Platform,
  channelId: string,
  userId: string,
  pending: Omit<import('./sessions.js').PendingClarification, 'askedAt'>
): Promise<void> {
  await setPendingClarification(platform, channelId, userId, {
    ...pending,
    askedAt: new Date().toISOString(),
  });
}

export async function tryDeploySourceFollowUp(
  platform: Platform,
  channelId: string,
  userId: string,
  text: string
): Promise<{ type: 'parsed'; parsed: ParsedCommand; reply: string } | { type: 'reply'; text: string } | null> {
  const session = await getSession(platform, channelId, userId);
  const pending = session?.pendingClarification;
  if (pending?.kind !== 'deploy-source') return null;

  if (/^deploy_source_cancel_/i.test(text.trim()) || /^(cancel|stop)\b/i.test(text.trim())) {
    if (pending.runId) await cancelRun(pending.runId).catch(() => undefined);
    await clearPendingClarification(platform, channelId, userId);
    return { type: 'reply', text: 'Cancelled — deploy source prompt cleared.' };
  }

  if (/^deploy_source_hotfix_/i.test(text.trim()) || /\bhot[- ]?fix\b/i.test(text.trim())) {
    await clearPendingClarification(platform, channelId, userId);
    const parsed: ParsedCommand = {
      type: 'investigate',
      scope: 'workload',
      namespace: pending.namespace ?? 'default',
      resourceName: pending.resourceName ?? '',
      resourceKind: pending.resourceKind ?? 'Deployment',
      label: pending.resourceName ?? 'workload',
      allowClusterHotFix: true,
      deployProvenance: {
        method: 'direct-apply',
        allowClusterHotFix: true,
      },
    };
    return {
      type: 'parsed',
      parsed,
      reply: 'Understood — I will use a temporary cluster hot-fix (may drift from Git). Retrying investigation…',
    };
  }

  const parsedSource = parseDeploySourceReply(text);
  if (parsedSource.cancelled) {
    if (pending.runId) await cancelRun(pending.runId).catch(() => undefined);
    await clearPendingClarification(platform, channelId, userId);
    return { type: 'reply', text: 'Cancelled.' };
  }

  if (!parsedSource.provenance && !parsedSource.allowClusterHotFix) {
    return null;
  }

  const merged = mergeDeployProvenance(pending.provenance, parsedSource.provenance, {
    allowClusterHotFix: parsedSource.allowClusterHotFix,
  });

  await clearPendingClarification(platform, channelId, userId);

  const parsed: ParsedCommand = {
    type: 'investigate',
    scope: 'workload',
    namespace: pending.namespace ?? 'default',
    resourceName: pending.resourceName ?? '',
    resourceKind: pending.resourceKind ?? 'Deployment',
    label: pending.resourceName ?? 'workload',
    deployProvenance: merged,
    allowClusterHotFix: merged.allowClusterHotFix,
    operatorSuggestion: text.trim(),
  };

  const repo = merged.sourceRepo ? `\`${merged.sourceRepo}\`` : 'cluster hot-fix';
  return {
    type: 'parsed',
    parsed,
    reply: `Got it — retrying fix using ${repo}${merged.chartPath ? ` chart \`${merged.chartPath}\`` : ''}.`,
  };
}

/** Fetch run metadata to arm clarification when user opens chat after deploy_source_required. */
export async function maybeArmDeploySourceFromRun(
  platform: Platform,
  channelId: string,
  userId: string,
  runId: string
): Promise<void> {
  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/runs/${encodeURIComponent(runId)}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return;
    const run = (await res.json()) as {
      status?: string;
      metadata?: {
        deploySourcePending?: {
          prompt?: string;
          provenance?: import('../../../shared/src/deploy-provenance.js').DeployProvenance;
        };
        request?: {
          namespace?: string;
          resourceName?: string;
          resourceKind?: import('../../../shared/src/types.js').ResourceKind;
        };
      };
    };
    if (run.status !== 'awaiting_human') return;
    const pending = run.metadata?.deploySourcePending;
    if (!pending?.prompt) return;
    const req = run.metadata?.request;
    await armDeploySourceClarification(platform, channelId, userId, {
      kind: 'deploy-source',
      awaiting: 'deploySource',
      prompt: pending.prompt,
      runId,
      namespace: req?.namespace,
      resourceName: req?.resourceName,
      resourceKind: req?.resourceKind,
      provenance: pending.provenance,
    });
  } catch {
    /* best effort */
  }
}

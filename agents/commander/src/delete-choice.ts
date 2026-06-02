/**
 * Resolve typo / vague workload names before delete (e.g. appache → apache).
 */

import type { Platform } from '../../../shared/src/types.js';
import type { DeleteCmd } from './parser.js';
import {
  fetchWorkloadResolution,
  type WorkloadCandidate,
} from './investigate-choice.js';

const CHOICE_TTL_MS = parseInt(process.env['DELETE_CHOICE_TTL_MS'] ?? '180000', 10);
const AUTO_DELETE_SCORE = 80;

interface PendingDelete {
  platform: Platform;
  channelId: string;
  userId: string;
  base: DeleteCmd;
  userHint: string;
  candidates: WorkloadCandidate[];
  expiresAt: number;
}

const pending = new Map<string, PendingDelete>();

function mapKey(platform: string, channelId: string, userId: string): string {
  return `${platform}:${channelId}:${userId}`;
}

function candidateToDelete(base: DeleteCmd, c: WorkloadCandidate, userHint: string): DeleteCmd {
  return {
    ...base,
    namespace: c.namespace,
    resourceName: c.resourceName,
    label: `${c.resourceName} in ${c.namespace}`,
    userHint,
  };
}

export type DeletePrepResult =
  | { status: 'proceed'; command: DeleteCmd }
  | { status: 'prompt'; prompt: string; candidates: WorkloadCandidate[] }
  | { status: 'not_found'; message: string };

function buildChoicePrompt(hint: string, candidates: WorkloadCandidate[]): string {
  const lines = candidates.map((c, i) => `${i + 1}. ${c.label} (match ${c.score}%)`);
  return [
    `I found several workloads that might match "${hint}". Which one should I delete?`,
    '',
    ...lines,
    '',
    'Reply with the number (1, 2, …) or `cancel`.',
  ].join('\n');
}

function pickAutoCandidate(
  hint: string,
  candidates: WorkloadCandidate[],
  autoConfirm?: WorkloadCandidate,
  needsConfirmation?: boolean
): WorkloadCandidate | null {
  if (candidates.length === 0) return null;
  if (autoConfirm) return autoConfirm;

  const top = candidates[0]!;
  const second = candidates[1];
  const h = hint.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const exact = candidates.find(
    (c) => c.resourceName.toLowerCase().replace(/[^a-z0-9-]/g, '') === h
  );
  if (exact) return exact;

  if (candidates.length === 1 && top.score >= AUTO_DELETE_SCORE) return top;
  if (!needsConfirmation && candidates.length === 1) return top;
  if (top.score >= AUTO_DELETE_SCORE && (!second || top.score - second.score >= 15)) {
    return top;
  }
  return null;
}

export async function prepareDeleteCommand(parsed: DeleteCmd): Promise<DeletePrepResult> {
  const hint = parsed.resourceName;
  const namespace = parsed.namespace !== '_all' ? parsed.namespace : undefined;
  const { needsConfirmation, autoConfirm, candidates } = await fetchWorkloadResolution(
    hint,
    namespace
  );

  const deployCandidates = candidates.filter(
    (c) => c.resourceKind === 'Deployment' || c.resourceKind === 'StatefulSet'
  );
  const pool = deployCandidates.length > 0 ? deployCandidates : candidates;

  if (pool.length === 0) {
    return {
      status: 'not_found',
      message:
        `I couldn't find a workload matching "${hint}"` +
        (namespace ? ` in namespace \`${namespace}\`` : '') +
        '. Check the name with `get deployments in <namespace>`.',
    };
  }

  const picked = pickAutoCandidate(hint, pool, autoConfirm, needsConfirmation);
  if (picked) {
    return { status: 'proceed', command: candidateToDelete(parsed, picked, hint) };
  }

  return {
    status: 'prompt',
    prompt: buildChoicePrompt(hint, pool.slice(0, 5)),
    candidates: pool.slice(0, 5),
  };
}

export function storeDeleteChoice(
  platform: Platform,
  channelId: string,
  userId: string,
  base: DeleteCmd,
  userHint: string,
  candidates: WorkloadCandidate[]
): void {
  pending.set(mapKey(platform, channelId, userId), {
    platform,
    channelId,
    userId,
    base,
    userHint,
    candidates,
    expiresAt: Date.now() + CHOICE_TTL_MS,
  });
}

export function tryResolvePendingDeleteChoice(
  platform: Platform,
  channelId: string,
  userId: string,
  text: string
): { status: 'none' | 'cancelled' | 'selected'; command?: DeleteCmd } {
  const normalized = text.trim().toLowerCase();
  if (['cancel', 'stop', 'abort', 'no'].includes(normalized)) {
    return resolveDeleteChoiceSelection(platform, channelId, userId, 'cancel');
  }
  const num = parseInt(normalized, 10);
  if (!Number.isNaN(num) && num >= 1) {
    return resolveDeleteChoiceSelection(platform, channelId, userId, num - 1);
  }
  return { status: 'none' };
}

export function resolveDeleteChoiceSelection(
  platform: Platform,
  channelId: string,
  userId: string,
  selection: 'cancel' | number
): { status: 'none' | 'cancelled' | 'selected'; command?: DeleteCmd } {
  const k = mapKey(platform, channelId, userId);
  const entry = pending.get(k);
  if (!entry) return { status: 'none' };
  if (Date.now() > entry.expiresAt) {
    pending.delete(k);
    return { status: 'none' };
  }
  if (selection === 'cancel') {
    pending.delete(k);
    return { status: 'cancelled' };
  }
  const candidate = entry.candidates[selection];
  if (!candidate) return { status: 'none' };

  pending.delete(k);
  return {
    status: 'selected',
    command: candidateToDelete(entry.base, candidate, entry.userHint),
  };
}

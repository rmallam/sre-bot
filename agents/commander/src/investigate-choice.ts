import { v4 as uuidv4 } from 'uuid';
import type { ResourceKind } from '../../../shared/src/types.js';
import type { InvestigateCmd } from './parser.js';

const INVESTIGATOR_URL = process.env['INVESTIGATOR_URL'] ?? 'http://investigator-agent:8080';
const CHOICE_TTL_MS = parseInt(process.env['INVESTIGATE_CHOICE_TTL_MS'] ?? '180000', 10);

export interface WorkloadCandidate {
  namespace: string;
  resourceKind: ResourceKind;
  resourceName: string;
  podName?: string;
  label: string;
  score: number;
  ready?: string;
  phase?: string;
}

interface PendingInvestigate {
  platform: 'telegram' | 'slack';
  channelId: string;
  userId: string;
  rawMessage: string;
  base: InvestigateCmd;
  candidates: WorkloadCandidate[];
  expiresAt: number;
}

const pending = new Map<string, PendingInvestigate>();

function key(platform: string, channelId: string, userId: string): string {
  return `${platform}:${channelId}:${userId}`;
}

function workloadHint(parsed: InvestigateCmd, rawMessage: string): string {
  if (parsed.workloadHint?.trim()) return parsed.workloadHint.trim();
  if (!parsed.resourceName.startsWith('_') && parsed.resourceName !== 'unknown') {
    return parsed.resourceName;
  }
  return extractLikelyWorkload(rawMessage);
}

function extractLikelyWorkload(raw: string): string {
  const text = raw.trim();
  const explicit = text.match(
    /\b(?:for|on|fix|remediate|repair|patch|update|change)\s+([a-z0-9][\w.-]*)\b/i
  );
  if (explicit?.[1] && !isStopToken(explicit[1])) return explicit[1];

  const dep = text.match(/\b([a-z0-9][\w.-]*)\s+deployment\b/i);
  if (dep?.[1] && !isStopToken(dep[1])) return dep[1];

  // Returning empty hint makes investigator return top candidates in namespace.
  return '';
}

function isStopToken(token: string): boolean {
  return new Set([
    'the',
    'a',
    'an',
    'deployment',
    'app',
    'application',
    'workload',
    'service',
    'pod',
    'image',
    'tag',
    'namespace',
    'cluster',
    'default',
  ]).has(token.toLowerCase());
}

function candidateToCommand(base: InvestigateCmd, c: WorkloadCandidate): InvestigateCmd {
  return {
    ...base,
    scope: 'workload',
    namespace: c.namespace,
    resourceName: c.resourceName,
    resourceKind: c.resourceKind,
    podName: c.podName,
    label: c.label,
    workloadConfirmed: true,
  };
}

export type InvestigatePrepResult =
  | { status: 'proceed'; command: InvestigateCmd }
  | { status: 'prompt'; prompt: string; candidates: WorkloadCandidate[] }
  | { status: 'not_found'; message: string };

async function fetchWorkloadResolution(
  hint: string,
  namespace: string | undefined
): Promise<{
  needsConfirmation: boolean;
  autoConfirm?: WorkloadCandidate;
  candidates: WorkloadCandidate[];
}> {
  const params = new URLSearchParams({
    hint,
    incidentId: `resolve-${uuidv4()}`,
  });
  if (namespace && namespace !== '_all' && namespace !== 'default') {
    params.set('namespace', namespace);
  }

  const res = await fetch(`${INVESTIGATOR_URL}/resolve-workload?${params}`, {
    signal: AbortSignal.timeout(45_000),
  }).catch(() => null);

  if (!res?.ok) {
    return { needsConfirmation: false, candidates: [] };
  }

  const body = (await res.json()) as {
    needsConfirmation?: boolean;
    autoConfirm?: WorkloadCandidate;
    candidates?: WorkloadCandidate[];
  };

  return {
    needsConfirmation: !!body.needsConfirmation,
    autoConfirm: body.autoConfirm,
    candidates: body.candidates ?? [],
  };
}

/**
 * Resolve vague workload hints against the cluster; ask the user when ambiguous.
 */
export async function prepareInvestigateCommand(
  parsed: InvestigateCmd,
  rawMessage: string
): Promise<InvestigatePrepResult> {
  if (parsed.scope !== 'workload' || parsed.workloadConfirmed) {
    return { status: 'proceed', command: parsed };
  }

  const hint = workloadHint(parsed, rawMessage);
  if (!hint) {
    return {
      status: 'not_found',
      message:
        "I couldn't tell which workload you mean. Try:\n• investigate the frappe deployment\n• investigate default/nginx",
    };
  }

  const ns =
    parsed.namespace && parsed.namespace !== '_all' ? parsed.namespace : undefined;
  const { needsConfirmation, autoConfirm, candidates } = await fetchWorkloadResolution(hint, ns);

  if (candidates.length === 0) {
    return {
      status: 'not_found',
      message: `I couldn't find a workload matching "${hint}" in the cluster. Try a more specific name or namespace/app.`,
    };
  }

  if (!needsConfirmation && autoConfirm) {
    const cmd = candidateToCommand(parsed, autoConfirm);
    return { status: 'proceed', command: cmd };
  }

  if (!needsConfirmation && candidates.length === 1) {
    return { status: 'proceed', command: candidateToCommand(parsed, candidates[0]!) };
  }

  return {
    status: 'prompt',
    prompt: buildChoicePrompt(hint, candidates),
    candidates,
  };
}

function buildChoicePrompt(hint: string, candidates: WorkloadCandidate[]): string {
  const lines = candidates.map((c, i) => `${i + 1}. ${c.label} (match ${c.score}%)`);
  if (!hint.trim()) {
    return [
      `I can help fix this, but I need the target workload first. Which one should I use?`,
      '',
      ...lines,
      '',
      'Reply with the number (1, 2, …) or `cancel`.',
    ].join('\n');
  }
  return [
    `I found several workloads that might match "${hint}". Which one did you mean?`,
    '',
    ...lines,
    '',
    'Reply with the number (1, 2, …) or `cancel`.',
  ].join('\n');
}

export function storeInvestigateChoice(
  platform: 'telegram' | 'slack',
  channelId: string,
  userId: string,
  rawMessage: string,
  base: InvestigateCmd,
  candidates: WorkloadCandidate[]
): void {
  pending.set(key(platform, channelId, userId), {
    platform,
    channelId,
    userId,
    rawMessage,
    base,
    candidates,
    expiresAt: Date.now() + CHOICE_TTL_MS,
  });
}

export function tryResolvePendingInvestigateChoice(
  platform: 'telegram' | 'slack',
  channelId: string,
  userId: string,
  text: string
): { status: 'none' | 'cancelled' | 'selected'; command?: InvestigateCmd } {
  const normalized = text.trim().toLowerCase();
  if (['cancel', 'stop', 'abort', 'no'].includes(normalized)) {
    return resolveInvestigateChoiceSelection(platform, channelId, userId, 'cancel');
  }
  const num = parseInt(normalized, 10);
  if (!Number.isNaN(num) && num >= 1) {
    return resolveInvestigateChoiceSelection(platform, channelId, userId, num - 1);
  }
  return { status: 'none' };
}

export function resolveInvestigateChoiceSelection(
  platform: 'telegram' | 'slack',
  channelId: string,
  userId: string,
  selection: 'cancel' | number
): { status: 'none' | 'cancelled' | 'selected'; command?: InvestigateCmd } {
  const k = key(platform, channelId, userId);
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
    command: candidateToCommand(entry.base, candidate),
  };
}

export function getPendingInvestigateCandidates(
  platform: 'telegram' | 'slack',
  channelId: string,
  userId: string
): WorkloadCandidate[] | undefined {
  const entry = pending.get(key(platform, channelId, userId));
  if (!entry || Date.now() > entry.expiresAt) return undefined;
  return entry.candidates;
}

export type InvestigateFlowOutcome =
  | { kind: 'reply'; text: string }
  | { kind: 'confirm'; prompt: string; candidates: WorkloadCandidate[] }
  | { kind: 'ready'; command: InvestigateCmd };

/** Resolve workload hint before starting an orchestrator run. */
export async function resolveInvestigateFlow(
  parsed: InvestigateCmd,
  rawMessage: string
): Promise<InvestigateFlowOutcome> {
  if (parsed.scope !== 'workload') {
    return { kind: 'ready', command: parsed };
  }

  const prep = await prepareInvestigateCommand(parsed, rawMessage);
  if (prep.status === 'not_found') {
    return { kind: 'reply', text: prep.message };
  }
  if (prep.status === 'prompt') {
    return { kind: 'confirm', prompt: prep.prompt, candidates: prep.candidates };
  }
  return { kind: 'ready', command: prep.command };
}

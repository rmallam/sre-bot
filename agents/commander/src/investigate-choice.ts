import { v4 as uuidv4 } from 'uuid';
import type { Platform } from '../../../shared/src/types.js';
import type { ComposeOptions } from '../../../shared/src/command-outcome.js';
import type { ResourceKind } from '../../../shared/src/types.js';
import type { InvestigateCmd } from './parser.js';
import { isWorkloadStatusQuery } from './parser.js';
import { composeUserReply } from './compose-outcome.js';
import {
  resolveInvestigateNamespace,
  resolveWorkloadHintForMessage,
  looksLikeImageRemediation,
} from './investigate-target.js';

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
  platform: Platform;
  channelId: string;
  userId: string;
  rawMessage: string;
  base: InvestigateCmd;
  candidates: WorkloadCandidate[];
  expiresAt: number;
  /** Answer with running status instead of starting diagnose run. */
  statusQuery?: boolean;
}

const pending = new Map<string, PendingInvestigate>();

function key(platform: string, channelId: string, userId: string): string {
  return `${platform}:${channelId}:${userId}`;
}

function workloadHint(parsed: InvestigateCmd, rawMessage: string): string {
  const resolved = resolveWorkloadHintForMessage(parsed, rawMessage);
  if (resolved) return resolved;
  if (!parsed.resourceName.startsWith('_') && parsed.resourceName !== 'unknown') {
    return parsed.resourceName;
  }
  return extractLikelyWorkload(rawMessage);
}

function extractLikelyWorkload(raw: string): string {
  const text = raw.trim();
  const fixTarget = text.match(
    /\b(?:fix|repair|remediate|patch|update|change)\s+(?:the\s+)?([a-z0-9][\w.-]*(?:-controller(?:-manager)?)?)\b/i
  );
  if (fixTarget?.[1] && !isStopToken(fixTarget[1])) return fixTarget[1];

  const explicit = text.match(
    /\b(?:for|on)\s+(?:the\s+)?([a-z0-9][\w.-]*)\b/i
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

function isImageRemediationRequest(parsed: InvestigateCmd, rawMessage: string): boolean {
  return !!parsed.operatorSuggestion?.trim() || looksLikeImageRemediation(rawMessage);
}

function deploymentControllers(candidates: WorkloadCandidate[]): WorkloadCandidate[] {
  return candidates.filter(
    (c) => c.resourceKind === 'Deployment' || c.resourceKind === 'StatefulSet'
  );
}

/** Image fixes apply to Deployments/StatefulSets — pick the best controller match. */
function bestControllerForHint(
  controllers: WorkloadCandidate[],
  hint: string
): WorkloadCandidate | undefined {
  if (controllers.length === 0) return undefined;
  const h = hint.trim().toLowerCase();
  if (!h) {
    return [...controllers].sort((a, b) => b.score - a.score)[0];
  }
  const exact = controllers.find((c) => c.resourceName.toLowerCase() === h);
  if (exact) return exact;
  const related = controllers.filter((c) => {
    const n = c.resourceName.toLowerCase();
    return n.startsWith(h) || h.startsWith(n) || n.includes(h) || h.includes(n);
  });
  if (related.length === 1) return related[0];
  if (related.length > 1) {
    return [...related].sort((a, b) => b.score - a.score)[0];
  }
  return [...controllers].sort((a, b) => b.score - a.score)[0];
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

export async function fetchWorkloadResolution(
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
  if (namespace && namespace !== '_all') {
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

  const ns = resolveInvestigateNamespace(parsed.namespace, rawMessage);
  let hint = workloadHint(parsed, rawMessage);

  if (!hint && !ns) {
    return {
      status: 'not_found',
      message:
        "I couldn't tell which workload you mean. Try:\n• investigate the frappe deployment\n• fix frappe-operator-system using ghcr.io/org/app:latest",
    };
  }

  let { needsConfirmation, autoConfirm, candidates } = await fetchWorkloadResolution(hint, ns);

  if (candidates.length === 0 && ns && hint) {
    const retry = await fetchWorkloadResolution('', ns);
    needsConfirmation = retry.needsConfirmation;
    autoConfirm = retry.autoConfirm;
    candidates = retry.candidates;
  }

  if (candidates.length === 0 && hint) {
    const retry = await fetchWorkloadResolution(hint, undefined);
    needsConfirmation = retry.needsConfirmation;
    autoConfirm = retry.autoConfirm;
    candidates = retry.candidates;
  }

  if (candidates.length === 0) {
    const subject = hint || ns || 'workload';
    return {
      status: 'not_found',
      message: `I couldn't find a workload matching "${subject}" in the cluster. Try a more specific name or namespace/app.`,
    };
  }

  // Image remediation always targets a controller — never ask user to pick a Pod.
  if (isImageRemediationRequest(parsed, rawMessage)) {
    const pick = bestControllerForHint(deploymentControllers(candidates), hint);
    if (pick) {
      return { status: 'proceed', command: candidateToCommand(parsed, pick) };
    }
  }

  const effectiveNs = ns ?? (parsed.namespace !== '_all' ? parsed.namespace : undefined);

  if (!needsConfirmation && autoConfirm) {
    const cmd = candidateToCommand(parsed, autoConfirm);
    return { status: 'proceed', command: cmd };
  }

  if (isWorkloadStatusQuery(rawMessage)) {
    const nsFilter =
      effectiveNs && effectiveNs !== '_all' && effectiveNs !== 'default' ? effectiveNs : ns;
    const inNs = candidates.filter(
      (c) =>
        (c.resourceKind === 'Deployment' || c.resourceKind === 'StatefulSet') &&
        (!nsFilter || c.namespace === nsFilter)
    );
    if (inNs.length === 1) {
      return { status: 'proceed', command: candidateToCommand(parsed, inNs[0]!) };
    }
    const exact = candidates.find(
      (c) =>
        c.resourceKind === 'Deployment' &&
        c.score >= 80 &&
        (!nsFilter || c.namespace === nsFilter)
    );
    if (exact) {
      return { status: 'proceed', command: candidateToCommand(parsed, exact) };
    }
  }

  if (!needsConfirmation && candidates.length === 1) {
    return { status: 'proceed', command: candidateToCommand(parsed, candidates[0]!) };
  }

  // Namespace-only fix ("fix frappe-operator-system") — pick best deployment in that ns
  if (ns && candidates.length > 1) {
    const inNs = candidates.filter((c) => c.namespace === ns && c.resourceKind === 'Deployment');
    const notReady = inNs.find((c) => {
      const m = c.ready?.match(/^(\d+)\/(\d+)$/);
      return m != null && m[1] !== m[2];
    });
    if (notReady) {
      return { status: 'proceed', command: candidateToCommand(parsed, notReady) };
    }
    const top = [...inNs].sort((a, b) => b.score - a.score)[0];
    if (top && top.score >= 40) {
      return { status: 'proceed', command: candidateToCommand(parsed, top) };
    }
  }

  return {
    status: 'prompt',
    prompt: buildChoicePrompt(hint || ns || 'workload', filterPromptCandidates(candidates, parsed, rawMessage)),
    candidates: filterPromptCandidates(candidates, parsed, rawMessage),
  };
}

function filterPromptCandidates(
  candidates: WorkloadCandidate[],
  parsed: InvestigateCmd,
  rawMessage: string
): WorkloadCandidate[] {
  if (!isImageRemediationRequest(parsed, rawMessage)) return candidates;
  const controllers = deploymentControllers(candidates);
  return controllers.length > 0 ? controllers : candidates;
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
  platform: Platform,
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
    statusQuery: isWorkloadStatusQuery(rawMessage),
  });
}

export function tryResolvePendingInvestigateChoice(
  platform: Platform,
  channelId: string,
  userId: string,
  text: string
): { status: 'none' | 'cancelled' | 'selected'; command?: InvestigateCmd; statusQuery?: boolean } {
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
  platform: Platform,
  channelId: string,
  userId: string,
  selection: 'cancel' | number
): { status: 'none' | 'cancelled' | 'selected'; command?: InvestigateCmd; statusQuery?: boolean } {
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
    statusQuery: entry.statusQuery,
  };
}

export function getPendingInvestigateCandidates(
  platform: Platform,
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
  rawMessage: string,
  composeOpts: ComposeOptions = {}
): Promise<InvestigateFlowOutcome> {
  if (parsed.scope !== 'workload') {
    return { kind: 'ready', command: parsed };
  }

  const prep = await prepareInvestigateCommand(parsed, rawMessage);
  const hint = workloadHint(parsed, rawMessage) || parsed.resourceName;

  if (prep.status === 'not_found') {
    const ns = resolveInvestigateNamespace(parsed.namespace, rawMessage);
    const text = await composeUserReply(
      {
        kind: 'not_found',
        subject: hint,
        namespace: ns,
        context: 'Try naming the deployment or namespace more specifically.',
      },
      composeOpts
    );
    return { kind: 'reply', text };
  }
  if (prep.status === 'prompt') {
    const prompt = await composeUserReply(
      {
        kind: 'choice_prompt',
        data: {
          subject: hint,
          options: prep.candidates.map((c) => ({ label: c.label, score: c.score })),
        },
      },
      composeOpts
    );
    return { kind: 'confirm', prompt, candidates: prep.candidates };
  }
  return { kind: 'ready', command: prep.command };
}

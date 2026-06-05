/**
 * RAG grounding via platform-agent — extract error signature and fetch runbook.
 */

import type { DiagnosisContext, SanitizedFacts } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import { platformRagGround, ragGroundingEnabled } from '../../../shared/src/platform-client.js';

const AGENT = 'orchestrator-rag';

const ERROR_SIGNATURES = [
  'CrashLoopBackOff',
  'OOMKilled',
  'ImagePullBackOff',
  'ErrImagePull',
  'CreateContainerConfigError',
  'FailedMount',
  'FailedScheduling',
  'Evicted',
  'ContainerCannotRun',
] as const;

const COMPONENT_HINTS: Record<string, string[]> = {
  storage: ['FailedMount', 'PersistentVolume', 'volume', 'PVC', 'mount'],
  network: ['ConnectionRefused', 'timeout', 'DNS', 'ingress', 'service'],
  gitops: ['ImagePullBackOff', 'ErrImagePull', 'git', 'helm', 'argocd'],
  compute: ['OOMKilled', 'CrashLoopBackOff', 'CPU', 'memory', 'Evicted'],
};

export interface RagGroundingResult {
  detectedError: string;
  targetComponent: string;
  retrievedPlaybook: string;
  similarity: number;
  found: boolean;
}

export function extractErrorSignature(facts: DiagnosisContext | SanitizedFacts): string {
  const events = facts.recentEvents ?? [];
  for (const sig of ERROR_SIGNATURES) {
    for (const e of events) {
      const blob = `${e.reason} ${e.message}`;
      if (blob.includes(sig)) return sig;
    }
  }

  for (const st of facts.containerStatuses ?? []) {
    const s = st as {
      state?: {
        waiting?: { reason?: string; message?: string };
        terminated?: { reason?: string; message?: string };
      };
    };
    const wait = s.state?.waiting?.reason ?? '';
    const term = s.state?.terminated?.reason ?? '';
    if (wait === 'CrashLoopBackOff' || wait === 'ImagePullBackOff') return wait;
    if (term === 'OOMKilled') return 'OOMKilled';
  }

  const logs = `${facts.currentLogs ?? ''}\n${facts.previousLogs ?? ''}`;
  if (/\boomkilled\b/i.test(logs)) return 'OOMKilled';
  if (/ImagePullBackOff|ErrImagePull/i.test(logs)) return 'ImagePullBackOff';
  if (/CrashLoopBackOff/i.test(logs)) return 'CrashLoopBackOff';

  return '';
}

export function inferTargetComponent(facts: DiagnosisContext | SanitizedFacts, error: string): string {
  const blob = [
    error,
    ...(facts.recentEvents ?? []).map((e) => `${e.reason} ${e.message}`),
    facts.currentLogs?.slice(0, 500) ?? '',
  ]
    .join(' ')
    .toLowerCase();

  for (const [component, hints] of Object.entries(COMPONENT_HINTS)) {
    if (hints.some((h) => blob.includes(h.toLowerCase()))) return component;
  }
  return 'compute';
}

export async function groundRunbookFromFacts(
  facts: SanitizedFacts,
  opts: {
    incidentId: string;
    resourceName: string;
    queryText?: string;
  }
): Promise<RagGroundingResult> {
  const empty: RagGroundingResult = {
    detectedError: '',
    targetComponent: 'compute',
    retrievedPlaybook: '',
    similarity: 0,
    found: false,
  };

  if (!ragGroundingEnabled()) return empty;

  const detectedError = extractErrorSignature(facts);
  if (!detectedError) {
    log('info', AGENT, 'No error signature for RAG grounding', { incidentId: opts.incidentId });
    return empty;
  }

  const targetComponent = inferTargetComponent(facts, detectedError);
  const rag = await platformRagGround({
    detectedError,
    targetComponent,
    targetWorkload: opts.resourceName,
    queryText: opts.queryText,
    incidentId: opts.incidentId,
  });

  if (!rag) {
    log('warn', AGENT, 'Platform RAG call failed', { incidentId: opts.incidentId });
    return { ...empty, detectedError, targetComponent };
  }

  log('info', AGENT, 'RAG grounded', {
    incidentId: opts.incidentId,
    error: detectedError,
    component: targetComponent,
    found: rag.found,
    similarity: rag.similarity,
  });

  return {
    detectedError,
    targetComponent,
    retrievedPlaybook: rag.playbookMarkdown,
    similarity: rag.similarity,
    found: rag.found,
  };
}

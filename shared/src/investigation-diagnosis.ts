/**
 * Extract primary failure signals from investigation facts (events + container status).
 */

import type { DiagnosisContext, KubeEvent, RemediationPlan } from './types.js';

export interface PrimaryFailure {
  signature: string;
  summary: string;
  detail?: string;
  imageRef?: string;
  containerName?: string;
  terminal: boolean;
  suggestedAction: 'ask_image' | 'restart' | 'patch_resources' | 'investigate_logs' | 'unknown';
}

const TERMINAL_WAIT_REASONS = new Set([
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'ImageInspectError',
  'CrashLoopBackOff',
  'CreateContainerConfigError',
  'CreateContainerError',
  'RunContainerError',
  'OOMKilled',
]);

const IMAGE_EVENT_REASONS = new Set(['Failed', 'ErrImagePull', 'BackOff']);

function containerWaitingReasons(statuses: object[]): Array<{
  name: string;
  reason: string;
  message?: string;
}> {
  const out: Array<{ name: string; reason: string; message?: string }> = [];
  for (const raw of statuses) {
    const s = raw as {
      name?: string;
      state?: {
        waiting?: { reason?: string; message?: string };
        terminated?: { reason?: string; message?: string };
      };
    };
    if (s.state?.waiting?.reason) {
      out.push({
        name: s.name ?? 'container',
        reason: s.state.waiting.reason,
        message: s.state.waiting.message,
      });
    }
    if (s.state?.terminated?.reason) {
      out.push({
        name: s.name ?? 'container',
        reason: s.state.terminated.reason,
        message: s.state.terminated.message,
      });
    }
  }
  return out;
}

export function extractImageRefFromText(text: string): string | undefined {
  const patterns = [
    /Failed to pull image "([^"]+)"/i,
    /pull (?:access denied|failed).*?"([^"]+)"/i,
    /image "([^"]+)"/i,
    /Pulling image "([^"]+)"/i,
    /container image "([^"]+)"/i,
    /\b([\w.-]+\/[\w.-]+:[\w.-]+)\b/,
    /\b([\w.-]+:[\w][\w.-]*)\b/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1] && !m[1].startsWith('http')) return m[1];
  }
  return undefined;
}

function imageFromEvents(events: KubeEvent[]): { imageRef?: string; detail?: string } {
  for (const e of events) {
    if (!IMAGE_EVENT_REASONS.has(e.reason) && !/pull|image/i.test(e.message)) continue;
    const imageRef = extractImageRefFromText(e.message);
    if (imageRef || /pull|image|back-off/i.test(e.message)) {
      return { imageRef, detail: `${e.reason}: ${e.message}`.slice(0, 400) };
    }
  }
  return {};
}

export function extractPrimaryFailure(facts: Partial<DiagnosisContext>): PrimaryFailure | null {
  const waiting = containerWaitingReasons(facts.containerStatuses ?? []);
  const events = facts.recentEvents ?? [];

  for (const w of waiting) {
    if (!TERMINAL_WAIT_REASONS.has(w.reason)) continue;
    const fromEvents = imageFromEvents(events);
    const imageRef =
      extractImageRefFromText(w.message ?? '') ?? fromEvents.imageRef;
    const detail = w.message ?? fromEvents.detail;

    if (w.reason === 'ImagePullBackOff' || w.reason === 'ErrImagePull' || w.reason === 'InvalidImageName') {
      return {
        signature: 'ImagePullBackOff',
        summary: imageRef
          ? `Image pull failed for \`${imageRef}\``
          : `Image pull failed (${w.reason})`,
        detail,
        imageRef,
        containerName: w.name,
        terminal: true,
        suggestedAction: 'ask_image',
      };
    }

    if (w.reason === 'CrashLoopBackOff') {
      return {
        signature: 'CrashLoopBackOff',
        summary: `Container \`${w.name}\` is in CrashLoopBackOff`,
        detail: w.message,
        containerName: w.name,
        terminal: true,
        suggestedAction: 'investigate_logs',
      };
    }

    if (w.reason === 'OOMKilled') {
      return {
        signature: 'OOMKilled',
        summary: `Container \`${w.name}\` was OOMKilled`,
        detail: w.message,
        containerName: w.name,
        terminal: true,
        suggestedAction: 'patch_resources',
      };
    }

    return {
      signature: w.reason,
      summary: `Container \`${w.name}\`: ${w.reason}`,
      detail: w.message,
      containerName: w.name,
      terminal: true,
      suggestedAction: 'unknown',
    };
  }

  for (const e of events) {
    for (const sig of ['ImagePullBackOff', 'ErrImagePull', 'CrashLoopBackOff', 'OOMKilled']) {
      if (`${e.reason} ${e.message}`.includes(sig)) {
        const imageRef = extractImageRefFromText(e.message);
        return {
          signature: sig,
          summary: imageRef ? `Image pull failed for \`${imageRef}\`` : `${sig} detected in events`,
          detail: `${e.reason}: ${e.message}`.slice(0, 400),
          imageRef,
          terminal: true,
          suggestedAction: sig.includes('Image') || sig.includes('Pull') ? 'ask_image' : 'unknown',
        };
      }
    }
  }

  const logs = `${facts.currentLogs ?? ''}\n${facts.previousLogs ?? ''}`;
  if (/ImagePullBackOff|ErrImagePull/i.test(logs)) {
    const imageRef = extractImageRefFromText(logs);
    return {
      signature: 'ImagePullBackOff',
      summary: imageRef ? `Image pull failed for \`${imageRef}\`` : 'Image pull failure in logs',
      imageRef,
      terminal: true,
      suggestedAction: 'ask_image',
    };
  }

  return null;
}

export function enrichFactsWithPrimaryFailure<T extends Partial<DiagnosisContext>>(facts: T): T {
  const primary = extractPrimaryFailure(facts);
  if (!primary) return facts;
  return {
    ...facts,
    detectedErrorSignature: primary.signature,
    observabilitySummary: primary.detail
      ? `${primary.summary}. ${primary.detail}`.slice(0, 600)
      : primary.summary,
  };
}

export function formatPrimaryFailureMessage(primary: PrimaryFailure): string {
  const lines = [`🔍 **Root cause:** ${primary.summary}`];
  if (primary.detail && !primary.summary.includes(primary.detail.slice(0, 40))) {
    lines.push(`_${primary.detail.slice(0, 280)}_`);
  }
  if (primary.suggestedAction === 'ask_image') {
    lines.push('', 'Reply with the correct **image tag** (e.g. `ghcr.io/org/app:v1.2`) or **`hot-fix cluster only`**.');
  }
  return lines.join('\n');
}

/** Override generic escalate plans when facts already show a terminal failure. */
export function adjustPlanForPrimaryFailure(
  ctx: DiagnosisContext,
  plan: RemediationPlan
): RemediationPlan {
  const primary = extractPrimaryFailure(ctx);
  if (!primary) return plan;

  if (primary.suggestedAction === 'ask_image') {
    const rootCause = primary.summary;
    const reasoning =
      `Container cannot start: ${primary.summary}.` +
      (primary.detail ? ` ${primary.detail}` : '') +
      ' Reply with the correct image tag or **`hot-fix cluster only`** to patch the workload in-cluster.';
    if (plan.action === 'escalate_human' || plan.proposedPatch.length === 0) {
      return {
        ...plan,
        action: 'escalate_human',
        rootCause,
        reasoning,
        severity: plan.severity === 'LOW' ? 'MEDIUM' : plan.severity,
        patchTarget: plan.patchTarget ?? 'cluster',
      };
    }
  }

  if (primary.terminal && plan.action === 'escalate_human' && !plan.rootCause.includes(primary.signature)) {
    return {
      ...plan,
      rootCause: primary.summary,
      reasoning: primary.detail ?? plan.reasoning,
    };
  }

  return plan;
}

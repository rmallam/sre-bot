/**
 * Success end-state messages — workloads ready, operator running, etc.
 */

import {
  flattenDeployWorkloads,
  parseDeployReleaseTargets,
  type DeployWorkloadRef,
} from './deploy-workloads.js';
import type { StoredRun } from './run-persistence.js';

export interface VerifySnapshot {
  healthy: boolean;
  namespace: string;
  releaseName: string;
  message: string;
  readyReplicas?: number;
  desiredReplicas?: number;
  recordedAt?: string;
}

export function parseVerifySnapshot(
  metadata: Record<string, unknown> | undefined
): VerifySnapshot | undefined {
  const raw = metadata?.verifySnapshot;
  if (!raw || typeof raw !== 'object') return undefined;
  return raw as VerifySnapshot;
}

function parseReadyParts(message: string): Array<{ name: string; ready: string }> {
  const dash = message.indexOf(' — ');
  if (dash < 0) return [];
  const tail = message.slice(dash + 3);
  return tail
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^(.+?)\s+(\d+\/\d+)$/);
      if (m) return { name: m[1]!.trim(), ready: m[2]! };
      return { name: part, ready: '' };
    });
}

function workloadLines(workloads: DeployWorkloadRef[], verifyMessage?: string): string[] {
  const parts = verifyMessage ? parseReadyParts(verifyMessage) : [];
  const byName = new Map(parts.map((p) => [p.name, p.ready]));

  if (workloads.length > 0) {
    return workloads.map((w) => {
      const ready = byName.get(w.resourceName);
      const suffix = ready ? ` — ${ready} ready` : '';
      return `• ${w.resourceName}${suffix}`;
    });
  }

  return parts.map((p) => (p.ready ? `• ${p.name} — ${p.ready} ready` : `• ${p.name}`));
}

/** User-facing success block for deploy / verify-complete runs. */
export function formatRunEndState(run: StoredRun): string | null {
  if (run.status !== 'succeeded') return null;

  const mode = String(run.metadata?.mode ?? '');
  const request = run.metadata?.request as Record<string, unknown> | undefined;
  const namespace = String(request?.namespace ?? '');
  const releaseName = String(request?.resourceName ?? '');
  const verify = parseVerifySnapshot(run.metadata);
  const workloads = flattenDeployWorkloads(parseDeployReleaseTargets(run.metadata));

  const verifyEntry = [...run.transcript].reverse().find((e) => e.tool === 'investigator.verify_health');
  const verifyOk = verify?.healthy ?? verifyEntry?.success;

  if (mode !== 'pre-deploy' && !verifyOk && mode !== 'diagnose') {
    return null;
  }

  if (mode === 'pre-deploy' || (verifyOk && workloads.length > 0)) {
    const ns = verify?.namespace || namespace;
    const app = verify?.releaseName || releaseName || 'the app';
    const lines: string[] = [];

    lines.push(`✅ **Deploy complete** — **${app}** is running${ns ? ` in namespace **${ns}**` : ''}.`);

    const ready = verify?.readyReplicas;
    const desired = verify?.desiredReplicas;
    if (ready != null && desired != null && desired > 0) {
      lines.push(`All components report ready (**${ready}/${desired}** replicas).`);
    } else if (verify?.message && /ready/i.test(verify.message)) {
      lines.push(verify.message.split(' — ')[0] ?? verify.message);
    }

    const items = workloadLines(workloads, verify?.message ?? verifyEntry?.error ?? verifyEntry?.summary);
    if (items.length > 0) {
      lines.push('', '**What is running:**', ...items.slice(0, 12));
      if (items.length > 12) {
        lines.push(`• …and ${items.length - 12} more`);
      }
    }

    if (ns) {
      lines.push('', `Check anytime: \`kubectl get pods -n ${ns}\``);
    }

    return lines.join('\n');
  }

  if (mode === 'diagnose' && verifyOk) {
    const target = releaseName && namespace ? `${releaseName} in ${namespace}` : releaseName || 'the workload';
    return (
      `✅ **Fix verified** — **${target}** looks healthy after the approved change.` +
      (verify?.message ? `\n${verify.message}` : '')
    );
  }

  if (verifyOk) {
    return `✅ **Completed successfully.**${verify?.message ? `\n${verify.message}` : ''}`;
  }

  return null;
}

export function formatRunEndStatePlain(run: StoredRun): string | null {
  const md = formatRunEndState(run);
  if (!md) return null;
  return md.replace(/\*\*/g, '');
}

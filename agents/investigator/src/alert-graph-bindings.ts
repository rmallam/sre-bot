/**
 * Resolve app-graph style dependency bindings for alert correlation.
 */

import * as k8s from '@kubernetes/client-node';
import { existsSync } from 'node:fs';
import { log } from '../../../shared/src/http.js';
import type { ResourceKind } from '../../../shared/src/types.js';
import { workloadKey, type CorrelatedWorkloadRef } from '../../../shared/src/alert-correlation.js';

const AGENT = 'investigator-alert-graph-bindings';

export interface WorkloadRef {
  namespace: string;
  resourceKind: ResourceKind;
  resourceName: string;
}

function buildKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token')) {
    try {
      kc.loadFromCluster();
    } catch {
      kc.loadFromDefault();
    }
  } else {
    kc.loadFromDefault();
  }
  return kc;
}

const ENV_HOST_PATTERNS = [
  /postgres(?:ql)?:\/\/[^@]+@([^:/]+)/i,
  /mysql:\/\/[^@]+@([^:/]+)/i,
  /redis(?:s)?:\/\/([^:/]+)/i,
  /amqp:\/\/[^@]+@([^:/]+)/i,
  /mongodb(?:\+srv)?:\/\/[^@]+@([^:/]+)/i,
];

function hostFromEnvValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  for (const re of ENV_HOST_PATTERNS) {
    const m = trimmed.match(re);
    if (m?.[1]) return m[1]!.toLowerCase();
  }
  if (/^[a-z0-9][a-z0-9.-]*\.svc(\.cluster\.local)?$/i.test(trimmed)) {
    return trimmed.split('.')[0]!.toLowerCase();
  }
  return null;
}

function hostsFromContainerEnv(env?: k8s.V1EnvVar[]): string[] {
  const hosts = new Set<string>();
  for (const item of env ?? []) {
    const raw = item.value ?? item.valueFrom?.configMapKeyRef?.name ?? '';
    const host = hostFromEnvValue(String(raw));
    if (host) hosts.add(host);
  }
  return [...hosts];
}

function graphBindingKey(hosts: string[]): string | null {
  if (hosts.length === 0) return null;
  const sorted = [...hosts].sort();
  return `graph-dep:${sorted.join('+')}`;
}

export async function resolveGraphBindingsForWorkloads(
  workloads: WorkloadRef[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (workloads.length === 0) return out;

  let apps: k8s.AppsV1Api;
  try {
    apps = buildKubeConfig().makeApiClient(k8s.AppsV1Api);
  } catch (err) {
    log('warn', AGENT, 'K8s client unavailable for graph bindings', { error: String(err) });
    return out;
  }

  for (const wl of workloads) {
    const wk = workloadKey(wl);
    try {
      if (wl.resourceKind === 'StatefulSet') {
        const res = await apps.readNamespacedStatefulSet(wl.resourceName, wl.namespace);
        const hosts = res.body.spec?.template?.spec?.containers?.flatMap((c) =>
          hostsFromContainerEnv(c.env)
        );
        const key = graphBindingKey([...new Set(hosts ?? [])]);
        if (key) out.set(wk, key);
        continue;
      }
      const res = await apps.readNamespacedDeployment(wl.resourceName, wl.namespace);
      const hosts = res.body.spec?.template?.spec?.containers?.flatMap((c) =>
        hostsFromContainerEnv(c.env)
      );
      const ann = res.body.metadata?.annotations?.['sre.bot/depends-on'];
      if (ann?.trim()) {
        for (const dep of ann.split(',').map((s) => s.trim()).filter(Boolean)) {
          hosts?.push(dep.toLowerCase());
        }
      }
      const key = graphBindingKey([...new Set(hosts ?? [])]);
      if (key) out.set(wk, key);
    } catch {
      /* skip missing workload */
    }
  }

  return out;
}

export function applyGraphBindingsToAlerts<T extends { namespace: string; resourceKind: ResourceKind; resourceName: string; labels: Record<string, string> }>(
  alerts: T[],
  bindings: Map<string, string>
): T[] {
  return alerts.map((alert) => {
    const key = bindings.get(workloadKey(alert));
    if (!key) return alert;
    return {
      ...alert,
      labels: { ...alert.labels, 'sre-graph-binding': key },
    };
  });
}

export function correlationKeyFromGraphBinding(labels: Record<string, string>): string | null {
  const binding = labels['sre-graph-binding']?.trim();
  return binding ? binding : null;
}

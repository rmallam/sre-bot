/**
 * Built-in RCA plugins — events, workload, cluster/namespace scope, Loki, Prometheus.
 */

import type { SpecialistDiagnostic } from '../types.js';
import type { RcaPointer } from '../rca-pointers.js';
import { pickSignalLogLines } from '../log-excerpt.js';
import {
  queryLokiLogs,
  queryPrometheusMetrics,
  observabilityBackendsConfigured,
} from '../observability-query.js';
import { log } from '../http.js';
import type { RcaGatherContext, RcaPlugin, RcaPluginResult } from './plugin.js';

const AGENT = 'rca-plugins';

function specialistToPointer(d: SpecialistDiagnostic): RcaPointer {
  return {
    source: d.specialist,
    title: `${d.specialist} specialist`,
    summary: d.summary,
    findings: d.findings,
    confidence: d.confidence,
  };
}

export const eventsPlugin: RcaPlugin = {
  id: 'events',
  isConfigured: () => true,
  isApplicable: (ctx) => (ctx.k8sFacts.recentEvents ?? []).some((e) => e.type === 'Warning'),
  async gather(ctx) {
    const warnings = (ctx.k8sFacts.recentEvents ?? [])
      .filter((e) => e.type === 'Warning')
      .slice(0, 8);
    if (warnings.length === 0) return null;
    return {
      pointer: {
        source: 'events',
        title: 'Kubernetes Warning events',
        summary: `${warnings.length} recent warning event(s)`,
        confidence: 0.85,
        findings: warnings.map((e) => `${e.reason}: ${e.message}`.slice(0, 200)),
      },
    };
  },
};

export const kubernetesWorkloadPlugin: RcaPlugin = {
  id: 'kubernetes-workload',
  isConfigured: () => true,
  isApplicable: (ctx) => ctx.scope === 'workload',
  async gather(ctx) {
    return {
      pointer: {
        source: 'kubernetes',
        title: 'Pod / workload snapshot',
        summary: `Captured spec, container status, and logs for ${ctx.namespace}/${ctx.resourceName}`,
        confidence: 0.9,
        findings: [
          `${(ctx.k8sFacts.containerStatuses ?? []).length} container status entries`,
          `${(ctx.k8sFacts.recentEvents ?? []).length} related events`,
        ],
      },
    };
  },
};

export const clusterScopePlugin: RcaPlugin = {
  id: 'cluster-scope',
  isConfigured: () => true,
  isApplicable: (ctx) => ctx.scope === 'cluster',
  async gather(ctx) {
    const meta = ctx.k8sFacts.scopeHealth;
    const reachable = ctx.k8sFacts.clusterReachable !== false;

    if (!reachable) {
      return {
        pointer: {
          source: 'kubernetes',
          title: 'Cluster unreachable',
          summary: ctx.k8sFacts.currentLogs?.slice(0, 200) ?? 'Kubernetes API unreachable',
          confidence: 0.95,
          findings: ['Cluster health check failed — verify control plane and credentials'],
        },
      };
    }

    const unhealthy = meta?.unhealthyDeployments ?? [];
    const nodeLine =
      meta?.nodeCount != null
        ? `${meta.nodeCount} node(s), ${meta.notReadyNodeCount ?? 0} not Ready`
        : 'Cluster nodes enumerated';

    const findings: string[] = [nodeLine];
    if (unhealthy.length > 0) {
      findings.push(
        ...unhealthy
          .slice(0, 8)
          .map((u) => `${u.namespace}/${u.name}: ${u.ready}/${u.desired} ready`)
      );
    } else {
      findings.push('All checked deployments report ready replicas');
    }

    return {
      pointer: {
        source: 'kubernetes',
        title: 'Cluster health overview',
        summary: `${unhealthy.length} deployment(s) not fully ready across the cluster`,
        confidence: unhealthy.length > 0 ? 0.92 : 0.7,
        findings,
      },
    };
  },
};

export const namespaceScopePlugin: RcaPlugin = {
  id: 'namespace-scope',
  isConfigured: () => true,
  isApplicable: (ctx) => ctx.scope === 'namespace',
  async gather(ctx) {
    const meta = ctx.k8sFacts.scopeHealth;
    const unhealthy = meta?.unhealthyDeployments ?? [];
    const depCount = ctx.k8sFacts.existingDeployments?.length ?? 0;

    const findings: string[] = [
      `Namespace ${ctx.namespace}: ${depCount} deployment(s) listed`,
    ];
    if (unhealthy.length > 0) {
      findings.push(
        ...unhealthy.map((u) => `${u.name}: ${u.ready}/${u.desired} ready`)
      );
    } else {
      findings.push('All deployments in namespace report ready replicas');
    }

    return {
      pointer: {
        source: 'kubernetes',
        title: `Namespace ${ctx.namespace} health`,
        summary: `${unhealthy.length} deployment(s) not fully ready in namespace`,
        confidence: unhealthy.length > 0 ? 0.9 : 0.65,
        findings,
      },
    };
  },
};

export const lokiPlugin: RcaPlugin = {
  id: 'loki',
  isConfigured: () => observabilityBackendsConfigured().loki,
  isApplicable: (ctx) => Boolean(ctx.namespace && ctx.namespace !== '_all'),
  async gather(ctx) {
    const topUnhealthy = ctx.k8sFacts.scopeHealth?.unhealthyDeployments?.[0];
    const deployment =
      ctx.scope === 'workload'
        ? ctx.resourceName
        : topUnhealthy?.name ?? (ctx.resourceName.startsWith('_') ? undefined : ctx.resourceName);
    const ns =
      ctx.scope === 'cluster' && topUnhealthy?.namespace
        ? topUnhealthy.namespace
        : ctx.namespace;

    const lokiRes = await queryLokiLogs({
      incidentId: ctx.incidentId,
      namespace: ns,
      podName: ctx.scope === 'workload' ? ctx.podName : undefined,
      deployment,
      sinceMinutes: 45,
    });

    if (!lokiRes || lokiRes.lines.length === 0) {
      log('debug', AGENT, 'Loki configured but no lines', {
        incidentId: ctx.incidentId,
        scope: ctx.scope,
        namespace: ns,
      });
      return null;
    }

    return {
      pointer: {
        source: 'loki',
        title: ctx.scope === 'cluster' ? 'Loki logs (top unhealthy workload)' : 'Loki log stream',
        summary: `${lokiRes.lines.length} signal lines from Loki (${lokiRes.truncated ? 'truncated' : 'complete'})`,
        confidence: 0.88,
        findings: pickSignalLogLines(lokiRes.lines, 5),
        excerpt: lokiRes.lines.slice(-12).join('\n').slice(0, 1500),
      },
      supplementalLogLines: lokiRes.lines,
    };
  },
};

export const prometheusPlugin: RcaPlugin = {
  id: 'prometheus',
  isConfigured: () => observabilityBackendsConfigured().prometheus,
  isApplicable: (ctx) => Boolean(ctx.namespace && ctx.namespace !== '_all'),
  async gather(ctx) {
    const topUnhealthy = ctx.k8sFacts.scopeHealth?.unhealthyDeployments?.[0];
    const ns =
      ctx.scope === 'cluster' && topUnhealthy?.namespace
        ? topUnhealthy.namespace
        : ctx.namespace;
    const deployment =
      ctx.scope === 'workload'
        ? ctx.resourceName
        : topUnhealthy?.name ?? (ctx.resourceName.startsWith('_') ? undefined : ctx.resourceName);

    const promRes = await queryPrometheusMetrics({
      incidentId: ctx.incidentId,
      namespace: ns,
      deployment,
      podName: ctx.scope === 'workload' ? ctx.podName : undefined,
    });

    if (!promRes) return null;
    if (promRes.samples.length === 0 && promRes.findings.length === 0) return null;

    return {
      pointer: {
        source: 'prometheus',
        title: ctx.scope === 'cluster' ? 'Prometheus (top unhealthy namespace)' : 'Prometheus metrics',
        summary: promRes.summary,
        confidence: promRes.findings.length > 0 ? 0.82 : 0.6,
        findings:
          promRes.findings.length > 0
            ? promRes.findings
            : promRes.samples.slice(0, 5).map((s) => `${s.metric}=${s.value}`),
      },
    };
  },
};

export function createDefaultRcaPlugins(): RcaPlugin[] {
  return [
    eventsPlugin,
    kubernetesWorkloadPlugin,
    clusterScopePlugin,
    namespaceScopePlugin,
    lokiPlugin,
    prometheusPlugin,
  ];
}

/** Run all specialist diagnostics as individual pointers (workload scope). */
export function specialistPluginsFrom(diagnostics: SpecialistDiagnostic[]): RcaPlugin[] {
  return diagnostics.map((d, i) => ({
    id: `specialist-${d.specialist}-${i}`,
    isConfigured: () => true,
    isApplicable: (ctx) => ctx.scope === 'workload',
    async gather(): Promise<RcaPluginResult> {
      return { pointer: specialistToPointer(d) };
    },
  }));
}

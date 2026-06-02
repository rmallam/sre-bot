/**
 * Synchronous fact gathering for orchestrator (GET /facts).
 */

import type {
  DiagnosisContext,
  InvestigateScope,
  ResourceKind,
  SpecialistDiagnostic,
} from '../../../shared/src/types.js';
import { gatherPodFacts } from './k8s-facts.js';
import { gatherPreDeployFacts } from './pre-deploy.js';
import { findManifest } from './git-mirror.js';
import {
  gatherClusterHealthFacts,
  gatherNamespaceHealthFacts,
  resolveDeploymentByHint,
} from './cluster-facts.js';
import { resolvePodForWorkload } from './workload-resolve.js';
import { enrichWithDeepRca } from './rca-enrich.js';

const GITOPS_REPO_URL = process.env['GITOPS_REPO_URL'] ?? '';

function workloadSpecialist(k8sFacts: Partial<DiagnosisContext>): SpecialistDiagnostic {
  const statuses = k8sFacts.containerStatuses ?? [];
  const restarting = statuses.filter((s) => {
    const rc = (s as { restartCount?: number }).restartCount ?? 0;
    return rc > 0;
  }).length;
  const findings: string[] = [];
  if (restarting > 0) findings.push(`${restarting} containers have restarts`);
  if ((k8sFacts.currentLogs ?? '').length > 0) findings.push('current container logs captured');
  if (Object.keys(k8sFacts.resourceLimits ?? {}).length === 0) findings.push('resource limits missing or unknown');
  return {
    specialist: 'workload',
    summary: findings[0] ?? 'No major workload anomaly detected',
    confidence: findings.length > 0 ? 0.85 : 0.5,
    findings,
  };
}

function networkSpecialist(
  namespace: string,
  resourceName: string,
  k8sFacts: Partial<DiagnosisContext>
): SpecialistDiagnostic {
  const eventLines = (k8sFacts.recentEvents ?? []).map((e) => `${e.reason} ${e.message}`.toLowerCase());
  const netSignals = eventLines.filter((l) =>
    /\b(dns|service|endpoint|ingress|connection refused|i\/o timeout|network)\b/.test(l)
  );
  const findings: string[] = [];
  if (netSignals.length > 0) findings.push(`network-related events: ${netSignals.slice(0, 3).join(' | ')}`);
  findings.push(`checked service routing clues for ${namespace}/${resourceName}`);
  return {
    specialist: 'network',
    summary: netSignals.length > 0 ? 'Potential network/routing issues detected' : 'No strong network signal',
    confidence: netSignals.length > 0 ? 0.75 : 0.45,
    findings,
  };
}

function databaseSpecialist(k8sFacts: Partial<DiagnosisContext>): SpecialistDiagnostic {
  const corpus = `${k8sFacts.currentLogs ?? ''}\n${k8sFacts.previousLogs ?? ''}`.toLowerCase();
  const patterns = [
    'too many connections',
    'connection pool',
    'sqlstate',
    'deadlock',
    'database is locked',
    'timeout expired',
  ];
  const hits = patterns.filter((p) => corpus.includes(p));
  return {
    specialist: 'database',
    summary: hits.length > 0 ? 'Database pressure or errors found in logs' : 'No direct database symptom in logs',
    confidence: hits.length > 0 ? 0.7 : 0.4,
    findings: hits.map((h) => `matched log pattern: ${h}`),
  };
}

export async function gatherFactsSync(opts: {
  incidentId: string;
  namespace: string;
  resourceName: string;
  resourceKind: ResourceKind;
  podName: string;
  mode: DiagnosisContext['mode'];
  githubRepo?: string;
  gitRef?: string;
  containerImage?: string;
  investigateScope?: InvestigateScope;
  rawMessage?: string;
}): Promise<DiagnosisContext> {
  if (opts.mode === 'pre-deploy' && (opts.githubRepo || opts.containerImage)) {
    const pre = await gatherPreDeployFacts({
      incidentId: opts.incidentId,
      triggeredBy: 'commander',
      triggeredAt: new Date().toISOString(),
      namespace: opts.namespace,
      resourceKind: opts.resourceKind,
      resourceName: opts.resourceName,
      mode: 'pre-deploy',
      githubRepo: opts.githubRepo,
      containerImage: opts.containerImage,
      gitRef: opts.gitRef ?? 'main',
      requestedBy: 'orchestrator',
      platform: 'web',
      channelId: '',
      rawMessage: '',
    });
    return {
      incidentId: opts.incidentId,
      triggeredBy: 'commander',
      triggeredAt: new Date().toISOString(),
      namespace: opts.namespace,
      resourceKind: opts.resourceKind,
      resourceName: opts.resourceName,
      mode: opts.mode,
      ...pre,
      safeMode: true,
    } as DiagnosisContext;
  }

  const scope = opts.investigateScope ?? inferScope(opts.resourceName);

  if (scope === 'cluster' || opts.resourceName === '_cluster') {
    const clusterFacts = await gatherClusterHealthFacts(opts.incidentId);
    return envelopeFromPartial(opts, clusterFacts);
  }

  if (scope === 'namespace' || opts.resourceName === '_namespace') {
    const ns = opts.namespace === '_all' ? 'default' : opts.namespace;
    const nsFacts = await gatherNamespaceHealthFacts(ns, opts.incidentId);
    return envelopeFromPartial(opts, { ...nsFacts, namespace: ns });
  }

  let namespace = opts.namespace === '_all' ? 'default' : opts.namespace;
  let resourceName = opts.resourceName;
  let resourceKind = opts.resourceKind;
  let podName = opts.podName || resourceName;

  const hint =
    resourceName === '_unresolved' ? (opts.rawMessage ?? '') : resourceName;
  if (hint && !hint.startsWith('_')) {
    const resolved = await resolveDeploymentByHint(
      hint,
      namespace !== 'default' && namespace !== '_all' ? namespace : undefined,
      opts.incidentId
    );
    if (resolved) {
      namespace = resolved.namespace;
      resourceName = resolved.resourceName;
      resourceKind = resolved.resourceKind;
    }
  }

  if (resourceKind !== 'Pod' || podName === resourceName) {
    const resolvedPod = await resolvePodForWorkload(
      namespace,
      resourceName,
      resourceKind,
      opts.incidentId
    );
    if (resolvedPod) {
      podName = resolvedPod;
    } else if (resourceKind !== 'Pod') {
      podName = resourceName;
    }
  }

  const [k8sFacts, manifestResult] = await Promise.all([
    gatherPodFacts(namespace, podName, resourceName, resourceKind, opts.incidentId),
    GITOPS_REPO_URL
      ? findManifest(resourceName, resourceKind, namespace)
      : Promise.resolve(null),
  ]);

  const specialistResults = await Promise.allSettled([
    Promise.resolve(workloadSpecialist(k8sFacts)),
    Promise.resolve(networkSpecialist(namespace, resourceName, k8sFacts)),
    Promise.resolve(databaseSpecialist(k8sFacts)),
  ]);
  const specialistDiagnostics = specialistResults
    .filter((r): r is PromiseFulfilledResult<SpecialistDiagnostic> => r.status === 'fulfilled')
    .map((r) => r.value);

  const deepRca = await enrichWithDeepRca({
    incidentId: opts.incidentId,
    namespace,
    resourceName,
    podName,
    k8sFacts,
    specialistDiagnostics,
  });

  return {
    incidentId: opts.incidentId,
    triggeredBy: 'commander',
    triggeredAt: new Date().toISOString(),
    namespace,
    resourceKind,
    resourceName,
    mode: opts.mode,
    podSpec: k8sFacts.podSpec ?? {},
    containerStatuses: k8sFacts.containerStatuses ?? [],
    resourceLimits: k8sFacts.resourceLimits ?? {},
    nodeInfo: k8sFacts.nodeInfo,
    recentEvents: k8sFacts.recentEvents ?? [],
    currentLogs: deepRca.enrichedCurrentLogs,
    previousLogs: deepRca.enrichedPreviousLogs,
    gitRepoUrl: GITOPS_REPO_URL || undefined,
    gitManifestPath: manifestResult?.path,
    gitManifestContent: manifestResult?.content,
    specialistDiagnostics,
    rcaPointers: deepRca.rcaPointers,
    observabilitySummary: deepRca.observabilitySummary,
    safeMode: true,
  };
}

function inferScope(resourceName: string): InvestigateScope {
  if (resourceName === '_cluster') return 'cluster';
  if (resourceName === '_namespace') return 'namespace';
  return 'workload';
}

function envelopeFromPartial(
  opts: {
    incidentId: string;
    namespace: string;
    resourceName: string;
    resourceKind: ResourceKind;
    mode: DiagnosisContext['mode'];
  },
  partial: Partial<DiagnosisContext>
): DiagnosisContext {
  return {
    incidentId: opts.incidentId,
    triggeredBy: 'commander',
    triggeredAt: new Date().toISOString(),
    namespace: partial.namespace ?? opts.namespace,
    resourceKind: partial.resourceKind ?? opts.resourceKind,
    resourceName: partial.resourceName ?? opts.resourceName,
    mode: opts.mode,
    podSpec: partial.podSpec ?? {},
    containerStatuses: partial.containerStatuses ?? [],
    resourceLimits: partial.resourceLimits ?? {},
    nodeInfo: partial.nodeInfo,
    recentEvents: partial.recentEvents ?? [],
    currentLogs: partial.currentLogs ?? '',
    previousLogs: partial.previousLogs ?? '',
    existingDeployments: partial.existingDeployments,
    gitRepoUrl: GITOPS_REPO_URL || undefined,
    gitManifestPath: partial.gitManifestPath,
    gitManifestContent: partial.gitManifestContent,
    safeMode: true,
  };
}

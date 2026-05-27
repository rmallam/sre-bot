/**
 * Synchronous fact gathering for orchestrator (GET /facts).
 */

import type { DiagnosisContext, ResourceKind } from '../../../shared/src/types.js';
import { gatherPodFacts } from './k8s-facts.js';
import { gatherPreDeployFacts } from './pre-deploy.js';
import { findManifest } from './git-mirror.js';

const GITOPS_REPO_URL = process.env.GITOPS_REPO_URL ?? '';

export async function gatherFactsSync(opts: {
  incidentId: string;
  namespace: string;
  resourceName: string;
  resourceKind: ResourceKind;
  podName: string;
  mode: DiagnosisContext['mode'];
  githubRepo?: string;
  gitRef?: string;
}): Promise<DiagnosisContext> {
  if (opts.mode === 'pre-deploy' && opts.githubRepo) {
    const pre = await gatherPreDeployFacts({
      incidentId: opts.incidentId,
      triggeredBy: 'commander',
      triggeredAt: new Date().toISOString(),
      namespace: opts.namespace,
      resourceKind: opts.resourceKind,
      resourceName: opts.resourceName,
      mode: 'pre-deploy',
      githubRepo: opts.githubRepo,
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

  const [k8sFacts, manifestResult] = await Promise.all([
    gatherPodFacts(opts.namespace, opts.podName, opts.resourceName, opts.resourceKind, opts.incidentId),
    GITOPS_REPO_URL
      ? findManifest(opts.resourceName, opts.resourceKind, opts.namespace)
      : Promise.resolve(null),
  ]);

  return {
    incidentId: opts.incidentId,
    triggeredBy: 'commander',
    triggeredAt: new Date().toISOString(),
    namespace: opts.namespace,
    resourceKind: opts.resourceKind,
    resourceName: opts.resourceName,
    mode: opts.mode,
    podSpec: k8sFacts.podSpec ?? {},
    containerStatuses: k8sFacts.containerStatuses ?? [],
    resourceLimits: k8sFacts.resourceLimits ?? {},
    nodeInfo: k8sFacts.nodeInfo,
    recentEvents: k8sFacts.recentEvents ?? [],
    currentLogs: k8sFacts.currentLogs ?? '',
    previousLogs: k8sFacts.previousLogs ?? '',
    gitRepoUrl: GITOPS_REPO_URL || undefined,
    gitManifestPath: manifestResult?.path,
    gitManifestContent: manifestResult?.content,
    safeMode: true,
  };
}

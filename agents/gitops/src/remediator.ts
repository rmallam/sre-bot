/**
 * remediator.ts — Main orchestration logic for the gitops-agent.
 *
 * Receives a RemediateCommand, applies the patch via RepoMirror,
 * polls ArgoCD for sync status, then POSTs a RemediationResult to both
 * Commander and HIL. Also resets the circuit breaker CRD attempt count
 * on success.
 */

import * as k8s from '@kubernetes/client-node';
import { log, postWithRetry } from '../../../shared/src/http.js';
import type { RemediateCommand, RemediationResult } from '../../../shared/src/types.js';
import { RepoMirror } from './repo-mirror.js';
import { waitForSync } from './argocd.js';
import { pushHelmToAppRepo, buildArgoApplicationManifest } from './app-repo.js';
import * as YAML from 'yaml';
import { applyRepoDirect } from './repo-direct.js';

const AGENT = 'gitops-agent';

// Singleton mirror — initialised once in index.ts
let repoMirror: RepoMirror;

export function setRepoMirror(mirror: RepoMirror): void {
  repoMirror = mirror;
}

// ── Environment ───────────────────────────────────────────────────────────────

const COMMANDER_URL = process.env['COMMANDER_URL'] ?? 'http://commander-agent:8080';
const HIL_URL = process.env['HIL_URL'] ?? 'http://hil-agent:8080';
const ARGOCD_URL = process.env['ARGOCD_URL'];
const ARGOCD_SYNC_TIMEOUT_MS = parseInt(
  process.env['ARGOCD_SYNC_TIMEOUT_MS'] ?? '300000', // 5 minutes default
  10,
);
const GITOPS_USE_PR = (process.env['GITOPS_USE_PR'] ?? 'false').toLowerCase() === 'true';

// ── Kubernetes client for CRD reset ─────────────────────────────────────────

function makeK8sClient(): k8s.CustomObjectsApi | null {
  try {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    return kc.makeApiClient(k8s.CustomObjectsApi);
  } catch (err: unknown) {
    log('warn', AGENT, 'Failed to initialise Kubernetes client — CRD reset will be skipped', {
      error: String(err),
    });
    return null;
  }
}

const k8sClient = makeK8sClient();

/**
 * resetAttemptCount — patches the SREIncident CRD to set attemptCount: 0
 * after a successful remediation, allowing the circuit breaker to reset.
 */
async function resetAttemptCount(
  incidentId: string,
  namespace: string,
  resourceName: string,
): Promise<void> {
  if (!k8sClient) {
    log('warn', AGENT, 'K8s client unavailable — skipping CRD attemptCount reset', { incidentId });
    return;
  }

  try {
    const name = resourceName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const patch = {
      status: {
        attemptCount: 0,
        escalated: false,
        approvalStatus: 'DONE',
        resolvedAt: new Date().toISOString(),
      }
    };

    await k8sClient.patchNamespacedCustomObjectStatus(
      'sre.bot',         // group
      'v1',              // version
      namespace,
      'sreincidents',    // plural
      name,
      patch,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } },
    );
    log('info', AGENT, 'Reset SREIncident status and attemptCount to 0', { incidentId, namespace, resourceName });
  } catch (err: unknown) {
    log('warn', AGENT, 'Failed to reset SREIncident attemptCount', {
      incidentId,
      namespace,
      resourceName,
      error: String(err),
    });
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function handleRemediate(cmd: RemediateCommand): Promise<RemediationResult> {
  const {
    incidentId,
    namespace,
    resourceKind,
    resourceName,
    plan,
    requestedBy,
    platform,
    channelId,
    runId,
  } = cmd;

  log('info', AGENT, 'Starting remediation', {
    incidentId,
    runId,
    namespace,
    resourceName,
    action: plan.action,
    manifestPath: plan.targetManifestPath,
    openPR: GITOPS_USE_PR,
  });

  const resultBase: Omit<RemediationResult, 'success' | 'error'> = {
    incidentId,
    triggeredBy: cmd.triggeredBy,
    triggeredAt: cmd.triggeredAt,
    namespace,
    resourceKind,
    resourceName,
    mode: cmd.mode,
    requestedBy,
    platform,
    channelId,
    runId,
  };

  let success = false;
  let error: string | undefined;
  let commitSha: string | undefined;
  let commitUrl: string | undefined;
  let appRepoCommitUrl: string | undefined;
  let argoCDSyncStatus: RemediationResult['argoCDSyncStatus'] = undefined;
  let dryRunPassed: boolean | undefined;

  try {
    if (plan.action === 'repo_apply') {
      await applyRepoDirect({
        incidentId,
        namespace,
        resourceName,
        plan,
        dryRun: cmd.executionOptions?.dryRun,
      });
      argoCDSyncStatus = 'Unknown';
    } else if (plan.action === 'helm_deploy') {
      const githubRepo = plan.githubRepo ?? '';
      if (!githubRepo) {
        throw new Error('helm_deploy requires plan.githubRepo (application repository)');
      }
      const gitRef = plan.gitRef ?? 'main';
      const chartPath =
        plan.targetManifestPath.replace(/\/Chart\.yaml$/i, '') || `deploy/helm/${resourceName}`;

      const chartFiles = plan.helmChart?.files;
      if (chartFiles && Object.keys(chartFiles).length > 0) {
        const appPush = await pushHelmToAppRepo({
          incidentId,
          githubRepo,
          gitRef,
          files: chartFiles,
          commitMessage: plan.commitMessage,
        });
        appRepoCommitUrl = appPush.commitUrl;
      } else {
        log('info', AGENT, 'Using existing Helm chart in app repo (no file push)', {
          incidentId,
          chartPath,
          githubRepo,
        });
      }

      const argoManifest = buildArgoApplicationManifest({
        appName: `${namespace}-${resourceName}`,
        namespace,
        githubRepo,
        chartPath,
        targetRevision: gitRef,
      });

      const applyResult = await repoMirror.applyPatchAndPush({
        incidentId,
        manifestPath: `applications/${namespace}-${resourceName}.yaml`,
        patch: [{ op: 'add', path: '', value: YAML.parse(argoManifest) }],
        commitMessage: `feat(argocd): register ${resourceName} application`,
        openPR: GITOPS_USE_PR,
      });
      commitSha = applyResult.commitSha;
      commitUrl = applyResult.commitUrl;
    } else {
      const applyResult = await repoMirror.applyPatchAndPush({
        incidentId,
        manifestPath: plan.targetManifestPath,
        patch: plan.proposedPatch,
        commitMessage: plan.commitMessage,
        openPR: GITOPS_USE_PR,
      });
      commitSha = applyResult.commitSha;
      commitUrl = applyResult.commitUrl;
    }

    dryRunPassed = true;

    if (plan.action !== 'repo_apply' && ARGOCD_URL) {
      const argoAppName = `${namespace}-${resourceName}`;
      const syncStatus = await waitForSync(argoAppName, ARGOCD_SYNC_TIMEOUT_MS);
      switch (syncStatus) {
        case 'Synced':
          argoCDSyncStatus = 'Synced';
          break;
        case 'Degraded':
          argoCDSyncStatus = 'Degraded';
          break;
        case 'Timeout':
          argoCDSyncStatus = 'OutOfSync';
          break;
        default:
          argoCDSyncStatus = 'Unknown';
      }
    } else if (plan.action !== 'repo_apply') {
      argoCDSyncStatus = 'Unknown';
    }

    success = plan.action === 'repo_apply'
      ? true
      : argoCDSyncStatus === 'Synced' || argoCDSyncStatus === 'Unknown';
    if (success) {
      await resetAttemptCount(incidentId, namespace, resourceName);
    }
  } catch (err: unknown) {
    error = String(err);
    dryRunPassed = dryRunPassed ?? false;
    success = false;
    log('error', AGENT, 'Remediation failed', { incidentId, error });
  }

  const result: RemediationResult = {
    ...resultBase,
    success,
    dryRunPassed,
    gitCommitSha: commitSha,
    gitCommitUrl: commitUrl,
    appRepoCommitUrl,
    argoCDSyncStatus,
    argoCDAppUrl: ARGOCD_URL && commitSha
      ? `${ARGOCD_URL.replace(/\/$/, '')}/applications/${namespace}-${resourceName}`
      : undefined,
    ...(error ? { error } : {}),
  };

  await postWithRetry({
    url: `${COMMANDER_URL}/confirm`,
    payload: result,
    incidentId,
    callerAgent: AGENT,
  });

  await postWithRetry({
    url: `${HIL_URL}/confirm`,
    payload: result,
    incidentId,
    callerAgent: AGENT,
  });

  return result;
}

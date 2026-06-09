/**
 * remediator.ts — Main orchestration logic for the gitops-agent.
 *
 * Receives a RemediateCommand, applies the patch via RepoMirror,
 * polls ArgoCD for sync status, then POSTs a RemediationResult to both
 * Commander and HIL. Also resets the circuit breaker CRD attempt count
 * on success.
 */

import * as k8s from '@kubernetes/client-node';
import { buildKubeConfig } from './kube-config.js';
import { log, postWithRetry } from '../../../shared/src/http.js';
import type { RemediateCommand, RemediationResult } from '../../../shared/src/types.js';
import { RepoMirror } from './repo-mirror.js';
import { waitForSync } from './argocd.js';
import { pushHelmToAppRepo, buildArgoApplicationManifest } from './app-repo.js';
import * as YAML from 'yaml';
import { applyRepoDirect } from './repo-direct.js';
import { applyClusterGitPatch } from './cluster-patch.js';
import {
  gitPatchTarget,
  shouldTryClusterPatch,
  shouldTryGitOpsMirror,
} from './patch-strategy.js';
import { sendDeployProgress } from '../../../shared/src/deploy-notify.js';
import { humanizeOperatorError } from '../../../shared/src/user-errors.js';

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
    const kc = buildKubeConfig();
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
        createNamespace: cmd.executionOptions?.createNamespace,
        platform,
        channelId,
        orchestratorManaged: Boolean(runId),
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

      try {
        const applyResult = await repoMirror.applyPatchAndPush({
          incidentId,
          manifestPath: `applications/${namespace}-${resourceName}.yaml`,
          patch: [{ op: 'add', path: '', value: YAML.parse(argoManifest) }],
          commitMessage: `feat(argocd): register ${resourceName} application`,
          openPR: GITOPS_USE_PR,
        });
        commitSha = applyResult.commitSha;
        commitUrl = applyResult.commitUrl;
      } catch (err) {
        const msg = String(err);
        const argoMissing =
          /argoproj\.io\/v1alpha1|kind ["']Application["']|CRDs are installed/i.test(msg);
        if (!argoMissing) {
          throw err;
        }
        log('warn', AGENT, 'Argo CD unavailable — direct Helm apply fallback', {
          incidentId,
          error: msg.slice(0, 240),
        });
        if (platform && channelId) {
          await sendDeployProgress(
            { incidentId, platform, channelId },
            'Argo CD is not installed in this cluster — applying the Helm chart directly instead of registering an Application.'
          );
        }
        await applyRepoDirect({
          incidentId,
          namespace,
          resourceName,
          plan: {
            ...plan,
            action: 'repo_apply',
            targetManifestPath:
              plan.targetManifestPath || `${chartPath.replace(/^\.\//, '')}/Chart.yaml`,
          },
          dryRun: cmd.executionOptions?.dryRun,
          createNamespace: cmd.executionOptions?.createNamespace,
          platform,
          channelId,
          orchestratorManaged: Boolean(runId),
        });
        argoCDSyncStatus = 'Unknown';
      }
    } else if (plan.action === 'git_patch') {
      const patchTarget = gitPatchTarget(cmd);
      const hasGitOpsRepo = Boolean(process.env['GITOPS_REPO_URL']?.trim());
      log('info', AGENT, 'git_patch apply strategy', {
        incidentId,
        patchTarget,
        hasGitOpsRepo,
      });

      let clusterApplied = false;
      if (shouldTryClusterPatch(patchTarget, plan.proposedPatch.length > 0)) {
        const clusterResult = await applyClusterGitPatch(cmd);
        if (clusterResult.success) {
          clusterApplied = true;
          success = true;
          dryRunPassed = true;
          argoCDSyncStatus = 'Unknown';
          log('info', AGENT, 'git_patch applied on cluster', {
            incidentId,
            patchTarget,
            target: `${clusterResult.targetKind}/${clusterResult.targetName}`,
          });
          if (platform && channelId) {
            await sendDeployProgress(
              { incidentId, platform, channelId },
              `✅ Applied fix on cluster: ${clusterResult.targetKind}/${clusterResult.targetName}`
            );
          }
        } else if (patchTarget === 'cluster' || (patchTarget === 'auto' && !hasGitOpsRepo)) {
          throw new Error(
            clusterResult.error ??
              'Could not apply fix on the cluster (check gitops-agent kubeconfig / API access)'
          );
        } else {
          log('warn', AGENT, 'Cluster patch failed — trying GitOps mirror', {
            incidentId,
            patchTarget,
            error: clusterResult.error,
          });
        }
      }

      if (
        shouldTryGitOpsMirror(patchTarget, clusterApplied, hasGitOpsRepo) &&
        plan.proposedPatch.length > 0
      ) {
        try {
          const applyResult = await repoMirror.applyPatchAndPush({
            incidentId,
            manifestPath: plan.targetManifestPath,
            patch: plan.proposedPatch,
            commitMessage: plan.commitMessage,
            openPR: GITOPS_USE_PR,
          });
          commitSha = applyResult.commitSha;
          commitUrl = applyResult.commitUrl;
          if (patchTarget === 'gitops' || !clusterApplied) {
            success = true;
            dryRunPassed = true;
          }
        } catch (mirrorErr) {
          const mirrorError = String(mirrorErr);
          if (!clusterApplied && shouldTryClusterPatch('cluster', plan.proposedPatch.length > 0)) {
            log('warn', AGENT, 'Git mirror failed — falling back to cluster hot-fix', {
              incidentId,
              error: mirrorError,
            });
            const clusterResult = await applyClusterGitPatch(cmd);
            if (clusterResult.success) {
              clusterApplied = true;
              success = true;
              dryRunPassed = true;
              argoCDSyncStatus = 'Unknown';
              if (platform && channelId) {
                await sendDeployProgress(
                  { incidentId, platform, channelId },
                  `✅ Git patch failed; applied cluster hot-fix on ${clusterResult.targetKind}/${clusterResult.targetName}`
                );
              }
            } else {
              throw new Error(
                `Git mirror failed (${mirrorError}); cluster hot-fix failed: ${clusterResult.error ?? 'unknown'}`
              );
            }
          } else {
            throw mirrorErr;
          }
        }
      } else if (patchTarget === 'gitops' && !hasGitOpsRepo) {
        throw new Error(
          'GITOPS_PATCH_MODE=gitops requires GITOPS_REPO_URL; use cluster or auto for direct cluster patches'
        );
      }
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

    if (!success) {
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
    }

    if (success) {
      await resetAttemptCount(incidentId, namespace, resourceName);
      if (runId) {
        const { stampWorkloadProvenance } = await import('./stamp-provenance.js');
        await stampWorkloadProvenance({
          incidentId,
          runId,
          namespace,
          resourceKind,
          resourceName,
          planAction: plan.action,
          provenance: {
            method:
              plan.action === 'helm_deploy'
                ? 'helm'
                : plan.action === 'repo_apply'
                  ? 'direct-apply'
                  : 'plain-yaml',
            sourceRepo: plan.githubRepo,
            chartPath: plan.targetManifestPath?.replace(/\/Chart\.yaml$/i, ''),
            manifestPath: plan.targetManifestPath,
            gitRef: plan.gitRef,
            argoApp: `${namespace}-${resourceName}`,
          },
        }).catch(() => undefined);
      }
    }
  } catch (err: unknown) {
    error = String(err);
    dryRunPassed = dryRunPassed ?? false;
    success = false;
    log('error', AGENT, 'Remediation failed', { incidentId, error });
    if (platform && channelId) {
      await sendDeployProgress(
        { incidentId, platform, channelId },
        `Deploy failed: ${humanizeOperatorError(error)}`
      );
    }
  }

  // For orchestrator-managed runs, final success/failure messaging happens in
  // orchestrator verifyNode to avoid "completed" before readiness is verified.
  if (success && platform && channelId && !runId) {
    await sendDeployProgress(
      { incidentId, platform, channelId },
      `Deploy completed successfully.\nVerify: oc get ns ${namespace}\noc get pods -n ${namespace}`
    );
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

  // Orchestrator-managed runs already own user messaging and final status.
  // Avoid duplicate/conflicting "Done"/"failed" messages from gitops in chat.
  if (!runId) {
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
  }

  return result;
}

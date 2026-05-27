import type { DiagnosisContext, RemediationPlan, StartRunRequest } from '../../../shared/src/types.js';
import { buildHelmDeployPlan, defaultChartPath } from '../../../shared/src/helm-generator.js';
import { callPlanLlm } from './tools.js';

function isHelmChartPath(manifestPath?: string): boolean {
  return !!manifestPath && /(^|\/)Chart\.yaml$/i.test(manifestPath);
}

function chartPathFromManifest(manifestPath: string): string {
  return manifestPath.replace(/\/Chart\.yaml$/i, '');
}

/**
 * Build deployment plan: use Helm scaffold when repo has no K8s entrypoint,
 * register Argo CD for existing Helm charts, otherwise let LLM patch manifests.
 */
export async function buildDeployPlan(
  ctx: DiagnosisContext,
  request: StartRunRequest
): Promise<RemediationPlan> {
  const githubRepo = request.githubRepo ?? ctx.githubRepo ?? '';
  const gitRef = request.gitRef ?? 'main';
  const appName = request.resourceName;
  const namespace = request.namespace;
  const deployStrategy = request.deployStrategy ?? 'gitops';

  const mustGenerate = ctx.needsHelmGeneration === true;

  if (mustGenerate && githubRepo) {
    const generatedPlan = buildHelmDeployPlan({
      appName,
      namespace,
      githubRepo,
      gitRef,
      repoSignals: ctx.repoSignals,
      existingManifest: false,
    });
    if (deployStrategy === 'direct') {
      return {
        ...generatedPlan,
        action: 'repo_apply',
        targetRepo: 'app',
        commitMessage: `feat(deploy): direct deploy generated Helm chart for ${appName}`,
      };
    }
    return generatedPlan;
  }

  if (githubRepo && isHelmChartPath(ctx.gitManifestPath)) {
    const chartManifestPath = ctx.gitManifestPath!;
    const chartPath = chartPathFromManifest(chartManifestPath);
    if (deployStrategy === 'direct') {
      return {
        action: 'repo_apply',
        rootCause: 'Repository already contains a Helm chart',
        reasoning: `Deploying directly from source chart path ${chartPath}/ without writing to app/GitOps repos.`,
        severity: 'MEDIUM',
        proposedPatch: [],
        targetManifestPath: chartManifestPath,
        commitMessage: `feat(deploy): direct deploy ${appName} from source Helm chart`,
        rollbackSafe: true,
        targetRepo: 'app',
        githubRepo,
        gitRef,
      };
    }
    return {
      action: 'helm_deploy',
      rootCause: 'Repository already contains a Helm chart',
      reasoning: `Registering Argo CD Application for existing chart at ${chartPath}/ (no chart regeneration).`,
      severity: 'MEDIUM',
      proposedPatch: [],
      targetManifestPath: ctx.gitManifestPath!,
      commitMessage: `feat(argocd): deploy ${appName} from existing Helm chart`,
      rollbackSafe: true,
      targetRepo: 'gitops',
      githubRepo,
      gitRef,
    };
  }

  if (deployStrategy === 'direct' && githubRepo && ctx.gitManifestPath) {
    return {
      action: 'repo_apply',
      rootCause: `Repository provides ${ctx.repoEntryPointKind ?? 'manifest'} deployment assets`,
      reasoning: `Applying source manifests directly from ${ctx.gitManifestPath} without Git push.`,
      severity: 'MEDIUM',
      proposedPatch: [],
      targetManifestPath: ctx.gitManifestPath,
      commitMessage: `feat(deploy): direct apply ${appName} from source repo`,
      rollbackSafe: true,
      targetRepo: 'app',
      githubRepo,
      gitRef,
    };
  }

  const plan = await callPlanLlm(ctx, []);

  if (request.mode === 'pre-deploy' && githubRepo && !plan.githubRepo) {
    return {
      ...plan,
      githubRepo,
      gitRef,
      targetRepo: plan.targetRepo ?? 'both',
      action: plan.action === 'git_patch' && mustGenerate ? 'helm_deploy' : plan.action,
      targetManifestPath:
        plan.targetManifestPath || `${defaultChartPath(appName)}/Chart.yaml`,
    };
  }

  return {
    ...plan,
    githubRepo: plan.githubRepo ?? githubRepo,
    gitRef: plan.gitRef ?? gitRef,
    targetRepo: plan.targetRepo ?? 'both',
  };
}

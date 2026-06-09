import type { DiagnosisContext, RemediationPlan, StartRunRequest } from '../../../shared/src/types.js';
import { buildHelmDeployPlan, defaultChartPath } from '../../../shared/src/helm-generator.js';
import { buildDeployPlanWithSourceBuild } from '../../../shared/src/deploy/build-plan.js';
import { isHelmChartPath } from '../../../shared/src/deploy/entry-point.js';
import {
  applyEnterpriseProfile,
  classifyEnterpriseDeployScenario,
  tagHelmDependencyScenario,
} from '../../../shared/src/deploy/enterprise-scenarios.js';
import { parseReadmeInstallHints } from '../../../shared/src/deploy/readme-install-hints.js';
import { callPlanLlm } from './tools.js';

function chartPathFromManifest(manifestPath: string): string {
  return manifestPath.replace(/\/Chart\.yaml$/i, '');
}

async function finalizeEnterprisePlan(
  base: RemediationPlan,
  ctx: DiagnosisContext,
  request: StartRunRequest,
  opts: { githubRepo: string; gitRef: string }
): Promise<RemediationPlan> {
  const readmeHints = ctx.gitReadmeContent
    ? parseReadmeInstallHints(ctx.gitReadmeContent)
    : null;
  let profile = classifyEnterpriseDeployScenario({ ctx, request, readmeHints });
  const manifestForDeps =
    profile.manifestPath ?? ctx.gitManifestPath ?? base.targetManifestPath;
  if (manifestForDeps && isHelmChartPath(manifestForDeps)) {
    profile = await tagHelmDependencyScenario(profile, manifestForDeps);
  }
  const plan = applyEnterpriseProfile(profile, base, opts);
  return { ...plan, enterpriseScenario: profile.scenario };
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
  const gitRef = request.gitRef ?? ctx.resolvedGitRef ?? 'main';
  const appName = request.resourceName;
  const namespace = request.namespace;
  const deployStrategy = request.deployStrategy ?? 'gitops';
  const containerImage = request.containerImage;
  const finalize = (plan: RemediationPlan) =>
    finalizeEnterprisePlan(plan, ctx, request, { githubRepo, gitRef });

  if (containerImage) {
    const generatedPlan = buildHelmDeployPlan({
      appName,
      namespace,
      githubRepo: appName,
      gitRef,
      existingManifest: false,
      image: containerImage,
    });
    return finalize({
      ...generatedPlan,
      action: 'repo_apply',
      targetRepo: 'app',
      githubRepo: undefined,
      rootCause: `Deploy container image ${containerImage}`,
      reasoning: `Catalog image deploy (${containerImage}) — apply generated Helm chart without cloning Git.`,
      commitMessage: `feat(deploy): deploy ${appName} from ${containerImage}`,
    });
  }

  const mustGenerate = ctx.needsHelmGeneration === true;

  if (mustGenerate && githubRepo) {
    if (ctx.repoSignals?.needsImageBuild) {
      const { plan } = await buildDeployPlanWithSourceBuild({
        ctx,
        appName,
        namespace,
        githubRepo,
        gitRef,
        deployStrategy,
      });
      return finalize(plan);
    }
    const generatedPlan = buildHelmDeployPlan({
      appName,
      namespace,
      githubRepo,
      gitRef,
      repoSignals: ctx.repoSignals,
      existingManifest: false,
    });
    if (deployStrategy === 'direct') {
      return finalize({
        ...generatedPlan,
        action: 'repo_apply',
        targetRepo: 'app',
        commitMessage: `feat(deploy): direct deploy generated Helm chart for ${appName}`,
      });
    }
    return finalize(generatedPlan);
  }

  if (githubRepo && isHelmChartPath(ctx.gitManifestPath)) {
    const chartManifestPath = ctx.gitManifestPath!;
    const chartPath = chartPathFromManifest(chartManifestPath);
    if (deployStrategy === 'direct') {
      return finalize({
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
      });
    }
    return finalize({
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
    });
  }

  if (deployStrategy === 'direct' && githubRepo && ctx.gitManifestPath) {
    return finalize({
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
    });
  }

  const plan = await callPlanLlm(ctx, []);

  const manifestPath = ctx.gitManifestPath ?? plan.targetManifestPath;
  if (request.mode === 'pre-deploy' && isHelmChartPath(manifestPath)) {
    const chartManifestPath = manifestPath!;
    const direct = deployStrategy === 'direct';
    if (direct) {
      return finalize({
        ...plan,
        action: 'repo_apply',
        rootCause: plan.rootCause || 'Repository contains a Helm chart',
        reasoning:
          plan.reasoning ||
          `Direct Helm install from ${chartPathFromManifest(chartManifestPath)}/ (no Git push).`,
        proposedPatch: [],
        targetManifestPath: chartManifestPath,
        targetRepo: 'app',
        githubRepo: plan.githubRepo ?? githubRepo,
        gitRef: plan.gitRef ?? gitRef,
      });
    }
    if (plan.action === 'git_patch') {
      return finalize({
        ...plan,
        action: 'helm_deploy',
        rootCause: plan.rootCause || 'Repository contains a Helm chart',
        reasoning:
          plan.reasoning ||
          `Register Argo CD Application for chart at ${chartPathFromManifest(chartManifestPath)}/.`,
        proposedPatch: [],
        targetManifestPath: chartManifestPath,
        targetRepo: 'gitops',
        githubRepo: plan.githubRepo ?? githubRepo,
        gitRef: plan.gitRef ?? gitRef,
      });
    }
  }

  if (request.mode === 'pre-deploy' && ctx.repoEntryPointKind === 'operator-install' && ctx.gitManifestPath) {
    return finalize({
      ...plan,
      action: deployStrategy === 'direct' ? 'repo_apply' : plan.action,
      targetManifestPath: ctx.gitManifestPath,
      targetRepo: deployStrategy === 'direct' ? 'app' : plan.targetRepo ?? 'both',
      githubRepo: plan.githubRepo ?? githubRepo,
      gitRef: plan.gitRef ?? gitRef,
      reasoning:
        plan.reasoning ||
        `Apply official operator install manifest from ${ctx.gitManifestPath}.`,
    });
  }

  if (request.mode === 'pre-deploy' && githubRepo && !plan.githubRepo) {
    return finalize({
      ...plan,
      githubRepo,
      gitRef,
      targetRepo: plan.targetRepo ?? 'both',
      action: plan.action === 'git_patch' && mustGenerate ? 'helm_deploy' : plan.action,
      targetManifestPath:
        plan.targetManifestPath || `${defaultChartPath(appName)}/Chart.yaml`,
    });
  }

  return finalize({
    ...plan,
    githubRepo: plan.githubRepo ?? githubRepo,
    gitRef: plan.gitRef ?? gitRef,
    targetRepo: plan.targetRepo ?? 'both',
  });
}

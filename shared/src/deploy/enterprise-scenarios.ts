/**
 * Enterprise deploy scenario taxonomy and deterministic plan routing.
 */

import type { DiagnosisContext, RemediationAction, RemediationPlan, StartRunRequest } from '../types.js';
import { isHelmChartPath } from './entry-point.js';
import { inspectHelmDependencies } from '../helm-dependencies.js';
import { isProdNamespace } from '../tool-policy.js';
import type { ReadmeInstallHints } from './readme-install-hints.js';
import { isLocalHelmChartPath, resolveDeployManifestPath } from './readme-install-hints.js';
import { assessDeployCollision, type DeployCollisionAssessment } from './collision-policy.js';

export type EnterpriseDeployScenario =
  | 'catalog-image'
  | 'source-build'
  | 'helm-existing'
  | 'helm-generated'
  | 'helm-with-dependencies'
  | 'kustomize-manifest'
  | 'plain-yaml-manifest'
  | 'operator-bundle'
  | 'operator-kubebuilder'
  | 'multi-service-stack'
  | 'readme-guided-helm'
  | 'readme-guided-kubectl'
  | 'helm-remote-repo'
  | 'namespace-missing'
  | 'existing-workload-collision'
  | 'prod-hil-gate'
  | 'no-argo-direct-fallback'
  | 'llm-manifest';

export interface EnterpriseDeployContext {
  ctx: DiagnosisContext;
  request: StartRunRequest;
  readmeHints?: ReadmeInstallHints | null;
  assumeNoArgo?: boolean;
  collision?: DeployCollisionAssessment;
}

export interface EnterpriseScenarioProfile {
  scenario: EnterpriseDeployScenario;
  tags: EnterpriseDeployScenario[];
  recommendedAction: RemediationAction;
  deployStrategy: 'gitops' | 'direct';
  reasoning: string;
  warnings: string[];
  requiresHil: boolean;
  preSteps: Array<'helm-dependency-fetch' | 'namespace-create' | 'reinstall-confirm'>;
  manifestPath?: string;
  helmRemote?: import('./readme-install-hints.js').RemoteHelmInstall;
}

function chartPathFromManifest(manifestPath: string): string {
  return manifestPath.replace(/\/Chart\.yaml$/i, '');
}

export function classifyEnterpriseDeployScenario(
  input: EnterpriseDeployContext
): EnterpriseScenarioProfile {
  const { ctx, request } = input;
  const deployStrategy = request.deployStrategy ?? 'gitops';
  const direct = deployStrategy === 'direct';
  const namespace = request.namespace;
  const appName = request.resourceName;
  const githubRepo = request.githubRepo ?? ctx.githubRepo ?? '';
  const tags: EnterpriseDeployScenario[] = [];
  const warnings: string[] = [];
  const preSteps: EnterpriseScenarioProfile['preSteps'] = [];

  const collision =
    input.collision ??
    assessDeployCollision({
      namespace,
      appName,
      existingDeployments: ctx.existingDeployments,
      userHint: request.rawMessage ?? request.userHints?.join(' '),
    });

  if (collision.warning) warnings.push(collision.warning);
  if (collision.requireReinstallConfirm) {
    tags.push('existing-workload-collision');
    preSteps.push('reinstall-confirm');
  }

  const prod = isProdNamespace(namespace);
  const requiresHil = prod;
  if (prod) tags.push('prod-hil-gate');

  if (ctx.namespaceExists === false) {
    tags.push('namespace-missing');
    preSteps.push('namespace-create');
  }

  const assumeNoArgo =
    input.assumeNoArgo ??
    ((process.env['DEPLOY_ASSUME_NO_ARGO'] ?? 'false').toLowerCase() === 'true' ||
      !(process.env['ARGOCD_URL'] ?? '').trim());
  if (assumeNoArgo && !direct) {
    tags.push('no-argo-direct-fallback');
  }

  const effectiveDirect = direct || assumeNoArgo;

  if (request.containerImage) {
    return {
      scenario: 'catalog-image',
      tags,
      recommendedAction: 'repo_apply',
      deployStrategy: effectiveDirect ? 'direct' : deployStrategy,
      reasoning: `Catalog/container image deploy (${request.containerImage}).`,
      warnings,
      requiresHil,
      preSteps,
    };
  }

  if (request.stackServices && request.stackServices.length > 1) {
    return {
      scenario: 'multi-service-stack',
      tags,
      recommendedAction: effectiveDirect ? 'repo_apply' : 'helm_deploy',
      deployStrategy: effectiveDirect ? 'direct' : 'gitops',
      reasoning: `Multi-service stack (${request.stackServices.length} services) with dependency ordering.`,
      warnings,
      requiresHil,
      preSteps,
    };
  }

  if (ctx.repoSignals?.needsImageBuild && ctx.needsHelmGeneration) {
    tags.push('source-build');
    return {
      scenario: 'source-build',
      tags,
      recommendedAction: effectiveDirect ? 'repo_apply' : 'helm_deploy',
      deployStrategy: effectiveDirect ? 'direct' : deployStrategy,
      reasoning: 'Build container image from source, then deploy generated Helm chart.',
      warnings,
      requiresHil: requiresHil || (process.env['SOURCE_BUILD_REQUIRE_HIL'] ?? 'true') === 'true',
      preSteps,
    };
  }

  const readme = input.readmeHints;

  if (readme?.remoteHelm && readme.remoteHelmRepo) {
    tags.push('helm-remote-repo');
    return {
      scenario: 'helm-remote-repo',
      tags,
      recommendedAction: 'repo_apply',
      deployStrategy: 'direct',
      reasoning:
        `Install from published Helm repo ${readme.remoteHelm.repoUrl} ` +
        `(${readme.remoteHelm.chartRef}) — no Git clone required.`,
      warnings,
      requiresHil,
      preSteps,
      helmRemote: readme.remoteHelm,
    };
  }

  const resolved = resolveDeployManifestPath({
    detectedManifestPath: ctx.gitManifestPath,
    readmeHints: readme,
  });

  if (
    readme?.method === 'helm' &&
    resolved.source === 'readme' &&
    resolved.manifestPath &&
    isLocalHelmChartPath(readme.chartPath)
  ) {
    tags.push('readme-guided-helm');
    return {
      scenario: 'readme-guided-helm',
      tags,
      recommendedAction: effectiveDirect ? 'repo_apply' : 'helm_deploy',
      deployStrategy: effectiveDirect ? 'direct' : deployStrategy,
      reasoning: `README prescribes Helm install from ${readme.chartPath}/.`,
      warnings,
      requiresHil,
      preSteps: [...preSteps, 'helm-dependency-fetch'],
      manifestPath: resolved.manifestPath,
    };
  }

  if (readme?.method === 'helm' && readme.remoteHelmRepo && resolved.source === 'detected' && resolved.manifestPath) {
    tags.push('readme-guided-helm');
    return {
      scenario: 'helm-existing',
      tags,
      recommendedAction: effectiveDirect ? 'repo_apply' : 'helm_deploy',
      deployStrategy: effectiveDirect ? 'direct' : deployStrategy,
      reasoning:
        resolved.note ??
        `Helm chart at ${chartPathFromManifest(resolved.manifestPath)}/ (README references remote Helm repo).`,
      warnings,
      requiresHil,
      preSteps: [...preSteps, 'helm-dependency-fetch'],
      manifestPath: resolved.manifestPath,
    };
  }

  if (readme?.method === 'kubectl' && readme.manifestPath && !/^https?:\/\//i.test(readme.manifestPath)) {
    tags.push('readme-guided-kubectl');
    return {
      scenario: 'readme-guided-kubectl',
      tags,
      recommendedAction: 'repo_apply',
      deployStrategy: 'direct',
      reasoning: `README prescribes kubectl apply -f ${readme.manifestPath}.`,
      warnings,
      requiresHil,
      preSteps,
      manifestPath: readme.manifestPath,
    };
  }

  const entryKind = ctx.repoEntryPointKind;
  const manifestPath = ctx.gitManifestPath;

  if (entryKind === 'operator-install' && manifestPath) {
    const scenario: EnterpriseDeployScenario = manifestPath.includes('config/manager')
      ? 'operator-kubebuilder'
      : 'operator-bundle';
    return {
      scenario,
      tags,
      recommendedAction: 'repo_apply',
      deployStrategy: 'direct',
      reasoning: `Operator install manifest at ${manifestPath} — direct apply.`,
      warnings,
      requiresHil,
      preSteps,
      manifestPath,
    };
  }

  if (manifestPath && isHelmChartPath(manifestPath)) {
    const scenario: EnterpriseDeployScenario = ctx.needsHelmGeneration ? 'helm-generated' : 'helm-existing';
    return {
      scenario,
      tags,
      recommendedAction: effectiveDirect ? 'repo_apply' : 'helm_deploy',
      deployStrategy: effectiveDirect ? 'direct' : deployStrategy,
      reasoning: effectiveDirect
        ? `Helm chart at ${chartPathFromManifest(manifestPath)}/ — direct install.`
        : `Helm chart at ${chartPathFromManifest(manifestPath)}/ — GitOps via Argo CD Application.`,
      warnings,
      requiresHil,
      preSteps: [...preSteps, 'helm-dependency-fetch'],
      manifestPath,
    };
  }

  if (ctx.needsHelmGeneration && githubRepo) {
    return {
      scenario: 'helm-generated',
      tags,
      recommendedAction: effectiveDirect ? 'repo_apply' : 'helm_deploy',
      deployStrategy: effectiveDirect ? 'direct' : deployStrategy,
      reasoning: 'No Kubernetes entrypoint found — generate Helm scaffold and deploy.',
      warnings,
      requiresHil,
      preSteps,
    };
  }

  if (entryKind === 'kustomize' && manifestPath) {
    return {
      scenario: 'kustomize-manifest',
      tags,
      recommendedAction: effectiveDirect ? 'repo_apply' : 'git_patch',
      deployStrategy: effectiveDirect ? 'direct' : deployStrategy,
      reasoning: effectiveDirect
        ? `Kustomize overlay at ${manifestPath} — kubectl apply -k.`
        : `Kustomize at ${manifestPath} — GitOps patch path.`,
      warnings,
      requiresHil,
      preSteps,
      manifestPath,
    };
  }

  if (entryKind === 'plain-yaml' && manifestPath) {
    return {
      scenario: 'plain-yaml-manifest',
      tags,
      recommendedAction: effectiveDirect ? 'repo_apply' : 'git_patch',
      deployStrategy: effectiveDirect ? 'direct' : deployStrategy,
      reasoning: effectiveDirect
        ? `Plain manifest ${manifestPath} — direct kubectl apply.`
        : `Plain manifest ${manifestPath} — GitOps git_patch.`,
      warnings,
      requiresHil,
      preSteps,
      manifestPath,
    };
  }

  return {
    scenario: 'llm-manifest',
    tags,
    recommendedAction: effectiveDirect ? 'repo_apply' : 'git_patch',
    deployStrategy: effectiveDirect ? 'direct' : deployStrategy,
    reasoning: 'Ambiguous repo layout — LLM plan with enterprise guardrails.',
    warnings,
    requiresHil,
    preSteps,
  };
}

export async function tagHelmDependencyScenario(
  profile: EnterpriseScenarioProfile,
  chartDirOrManifest: string
): Promise<EnterpriseScenarioProfile> {
  const chartDir = chartDirOrManifest.replace(/\/Chart\.yaml$/i, '');
  try {
    const info = await inspectHelmDependencies(chartDir);
    if (info.hasDependencies && !info.vendored) {
      return {
        ...profile,
        scenario: 'helm-with-dependencies',
        tags: [...profile.tags, 'helm-with-dependencies'],
        preSteps: profile.preSteps.includes('helm-dependency-fetch')
          ? profile.preSteps
          : [...profile.preSteps, 'helm-dependency-fetch'],
        reasoning: `${profile.reasoning} Subchart dependencies (${info.names.join(', ')}) will be fetched automatically.`,
      };
    }
  } catch {
    /* chart dir may not exist locally at plan time */
  }
  return profile;
}

export function applyEnterpriseProfile(
  profile: EnterpriseScenarioProfile,
  base: RemediationPlan,
  opts: { githubRepo?: string; gitRef?: string }
): RemediationPlan {
  const manifestPath = profile.manifestPath ?? base.targetManifestPath;
  const plan: RemediationPlan = {
    ...base,
    action: profile.recommendedAction,
    targetManifestPath: manifestPath || base.targetManifestPath,
    reasoning: profile.reasoning || base.reasoning,
    githubRepo: profile.scenario === 'helm-remote-repo' ? undefined : base.githubRepo ?? opts.githubRepo,
    gitRef: profile.scenario === 'helm-remote-repo' ? undefined : base.gitRef ?? opts.gitRef,
    helmRemote: profile.helmRemote ?? base.helmRemote,
    targetRepo:
      profile.recommendedAction === 'repo_apply'
        ? 'app'
        : profile.deployStrategy === 'direct'
          ? 'app'
          : base.targetRepo ?? 'gitops',
  };

  if (profile.recommendedAction === 'helm_deploy' || profile.recommendedAction === 'repo_apply') {
    plan.proposedPatch = [];
  }

  if (profile.warnings.length) {
    plan.reasoning = `${plan.reasoning} [${profile.warnings.join(' ')}]`;
  }

  return plan;
}

export const ENTERPRISE_DEPLOY_SCENARIO_MATRIX: Array<{
  scenario: EnterpriseDeployScenario;
  description: string;
}> = [
  { scenario: 'catalog-image', description: 'Deploy from built-in or explicit container image (no Git clone)' },
  { scenario: 'source-build', description: 'Build image from Dockerfile/buildpacks/S2I then deploy' },
  { scenario: 'helm-existing', description: 'Repository contains a Helm chart — install or GitOps register' },
  { scenario: 'helm-generated', description: 'No manifests — generate Helm scaffold under deploy/helm/' },
  { scenario: 'helm-with-dependencies', description: 'Helm chart with Chart.yaml dependencies — auto helm dependency update' },
  { scenario: 'kustomize-manifest', description: 'Kustomize overlay — kubectl apply -k or GitOps patch' },
  { scenario: 'plain-yaml-manifest', description: 'Plain Kubernetes YAML manifests' },
  { scenario: 'operator-bundle', description: 'Operator install.yaml bundle — direct apply' },
  { scenario: 'operator-kubebuilder', description: 'Kubebuilder config/manager manifest' },
  { scenario: 'multi-service-stack', description: 'Multiple related services with dependency order' },
  { scenario: 'readme-guided-helm', description: 'README documents helm install — prefer documented chart path' },
  { scenario: 'readme-guided-kubectl', description: 'README documents kubectl apply — use documented manifest' },
  { scenario: 'helm-remote-repo', description: 'Published Helm repo — helm repo add + install without Git clone' },
  { scenario: 'namespace-missing', description: 'Target namespace does not exist — create before apply' },
  { scenario: 'existing-workload-collision', description: 'Namespace has deployments — upgrade vs reinstall confirm' },
  { scenario: 'prod-hil-gate', description: 'Production namespace — human approval required' },
  { scenario: 'no-argo-direct-fallback', description: 'No Argo CD — direct Helm/kubectl even in gitops mode' },
  { scenario: 'llm-manifest', description: 'Fallback LLM plan with guardrails' },
];

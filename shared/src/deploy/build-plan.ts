/**
 * Merge source-build output into Helm deploy planning.
 */

import type { DiagnosisContext, RemediationPlan } from '../types.js';
import { buildHelmDeployPlan } from '../helm-generator.js';
import { planSourceBuild } from './source-build.js';
import type { DetectedRuntime } from './runtime-detect.js';

export async function buildDeployPlanWithSourceBuild(opts: {
  ctx: DiagnosisContext;
  appName: string;
  namespace: string;
  githubRepo: string;
  gitRef: string;
  repoDir?: string;
  deployStrategy: 'gitops' | 'direct';
}): Promise<{ plan: RemediationPlan; buildSummary?: string }> {
  const signals = opts.ctx.repoSignals;
  const mustGenerate = opts.ctx.needsHelmGeneration === true;

  if (!mustGenerate || !signals?.needsImageBuild) {
    return { plan: buildHelmDeployPlan({
      appName: opts.appName,
      namespace: opts.namespace,
      githubRepo: opts.githubRepo,
      gitRef: opts.gitRef,
      repoSignals: signals,
      existingManifest: false,
      image: signals?.suggestedImage,
    }) };
  }

  // Image already built by orchestrator build node (DEPLOY-2d).
  if (signals.suggestedImage) {
    const generatedPlan = buildHelmDeployPlan({
      appName: opts.appName,
      namespace: opts.namespace,
      githubRepo: opts.githubRepo,
      gitRef: opts.gitRef,
      repoSignals: signals,
      existingManifest: false,
      image: signals.suggestedImage,
    });
    const reasoning = `${generatedPlan.reasoning}\n\nSource build: using ${signals.suggestedImage}`;
    const plan =
      opts.deployStrategy === 'direct'
        ? {
            ...generatedPlan,
            action: 'repo_apply' as const,
            targetRepo: 'app' as const,
            reasoning,
            commitMessage: `feat(deploy): direct deploy ${opts.appName} with built image`,
          }
        : { ...generatedPlan, reasoning };
    return { plan, buildSummary: `Built image ${signals.suggestedImage}` };
  }

  const build = await planSourceBuild({
    incidentId: opts.ctx.incidentId,
    appName: opts.appName,
    namespace: opts.namespace,
    githubRepo: opts.githubRepo,
    gitRef: opts.gitRef,
    repoDir: opts.repoDir ?? '',
    runtime: (signals.detectedRuntime ?? 'unknown') as DetectedRuntime,
    strategy: signals.buildStrategy ?? 'buildpacks',
  });

  const generatedPlan = buildHelmDeployPlan({
    appName: opts.appName,
    namespace: opts.namespace,
    githubRepo: opts.githubRepo,
    gitRef: opts.gitRef,
    repoSignals: signals,
    existingManifest: false,
    image: build.image,
  });

  const reasoning =
    `${generatedPlan.reasoning}\n\nSource build: ${build.summary}`;

  if (!build.success && build.error === 'needs_image_build') {
    return {
      plan: {
        ...generatedPlan,
        action: 'escalate_human',
        rootCause: 'Repository has no container image or Dockerfile',
        reasoning: build.summary,
        severity: 'MEDIUM',
      },
      buildSummary: build.summary,
    };
  }

  const plan =
    opts.deployStrategy === 'direct'
      ? {
          ...generatedPlan,
          action: 'repo_apply' as const,
          targetRepo: 'app' as const,
          reasoning,
          commitMessage: `feat(deploy): direct deploy ${opts.appName} with built image`,
        }
      : { ...generatedPlan, reasoning };

  return { plan, buildSummary: build.summary };
}

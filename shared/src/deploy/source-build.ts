/**
 * Source-to-image / buildpack build plugins (DEPLOY-2).
 */

import type { DetectedRuntime, SourceBuildStrategy } from './runtime-detect.js';

export interface SourceBuildContext {
  incidentId: string;
  appName: string;
  namespace: string;
  githubRepo: string;
  gitRef: string;
  repoDir: string;
  runtime: DetectedRuntime;
  strategy: SourceBuildStrategy;
}

export interface SourceBuildResult {
  success: boolean;
  image: string;
  digest?: string;
  summary: string;
  error?: string;
}

export interface SourceBuildPlugin {
  id: string;
  strategy: SourceBuildStrategy;
  isAvailable(): boolean;
  build(ctx: SourceBuildContext): Promise<SourceBuildResult>;
}

export function defaultBuiltImageRef(opts: {
  appName: string;
  githubRepo?: string;
  tag?: string;
}): string {
  const registry = (process.env['IMAGE_REGISTRY'] ?? 'ghcr.io/sre-bot').replace(/\/$/, '');
  const slug =
    opts.githubRepo?.replace(/^https?:\/\//, '').replace(/^github\.com\//, '').toLowerCase() ??
    opts.appName.toLowerCase();
  const tag = opts.tag ?? 'latest';
  return `${registry}/${slug}/${opts.appName.toLowerCase()}:${tag}`;
}

/** Phase 1: plan-only — records intended image; cluster build wired in build-agent. */
export async function planSourceBuild(ctx: SourceBuildContext): Promise<SourceBuildResult> {
  const image = defaultBuiltImageRef({ appName: ctx.appName, githubRepo: ctx.githubRepo });

  if (ctx.strategy === 'skip') {
    return {
      success: false,
      image,
      summary: 'No Dockerfile and runtime not detected — cannot build image automatically.',
      error: 'needs_image_build',
    };
  }

  const buildEnabled = (process.env['SOURCE_BUILD_ENABLED'] ?? 'false').toLowerCase() === 'true';
  if (!buildEnabled) {
    return {
      success: true,
      image,
      summary:
        `Image build planned (${ctx.strategy}, ${ctx.runtime}) → ${image}. ` +
        `Set SOURCE_BUILD_ENABLED=true and configure IMAGE_REGISTRY to execute builds.`,
    };
  }

  for (const plugin of createSourceBuildPlugins()) {
    if (plugin.strategy !== ctx.strategy || !plugin.isAvailable()) continue;
    return plugin.build(ctx);
  }

  return {
    success: false,
    image,
    summary: `No ${ctx.strategy} builder available in this environment.`,
    error: 'builder_unavailable',
  };
}

export function createSourceBuildPlugins(): SourceBuildPlugin[] {
  return [new BuildpacksPlugin(), new S2iPluginStub()];
}

class BuildpacksPlugin implements SourceBuildPlugin {
  id = 'buildpacks';
  strategy = 'buildpacks' as const;

  isAvailable(): boolean {
    return (process.env['PACK_CLI_PATH'] ?? '').length > 0;
  }

  async build(ctx: SourceBuildContext): Promise<SourceBuildResult> {
    const image = defaultBuiltImageRef({ appName: ctx.appName, githubRepo: ctx.githubRepo });
    return {
      success: false,
      image,
      summary: 'Buildpack CLI configured but in-cluster pack build not wired yet (DEPLOY-2b).',
      error: 'not_implemented',
    };
  }
}

class S2iPluginStub implements SourceBuildPlugin {
  id = 's2i-openshift';
  strategy = 's2i' as const;

  isAvailable(): boolean {
    return (process.env['OPENSHIFT_API_URL'] ?? '').length > 0;
  }

  async build(ctx: SourceBuildContext): Promise<SourceBuildResult> {
    const image = defaultBuiltImageRef({ appName: ctx.appName, githubRepo: ctx.githubRepo });
    return {
      success: false,
      image,
      summary: 'OpenShift S2I BuildConfig integration pending (DEPLOY-2c).',
      error: 'not_implemented',
    };
  }
}

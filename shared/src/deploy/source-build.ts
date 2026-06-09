/**
 * Source-to-image / buildpack build plugins (DEPLOY-2).
 */

import type { DetectedRuntime, SourceBuildStrategy } from './runtime-detect.js';
import { sourceBuildEnabled } from './source-build-gate.js';

const INVESTIGATOR_URL = process.env['INVESTIGATOR_URL'] ?? 'http://investigator-agent:8080';
const SOURCE_BUILD_FETCH_TIMEOUT_MS = parseInt(
  process.env['SOURCE_BUILD_FETCH_TIMEOUT_MS'] ?? '900000',
  10
);

async function postInvestigatorBuild<T>(url: string, body: unknown, incidentId: string): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SOURCE_BUILD_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Investigator build failed: HTTP ${res.status} ${text.slice(0, 400)}`);
  }
  return res.json() as Promise<T>;
}

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

  if (!sourceBuildEnabled()) {
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
  return [new DockerfileKanikoPlugin(), new BuildpacksPlugin(), new S2iPlugin()];
}

/** Call investigator POST /build/from-source (DEPLOY-2b). */
export async function executeSourceBuildViaInvestigator(
  ctx: SourceBuildContext
): Promise<SourceBuildResult> {
  return postInvestigatorBuild<SourceBuildResult>(
    `${INVESTIGATOR_URL}/build/from-source`,
    {
      incidentId: ctx.incidentId,
      appName: ctx.appName,
      namespace: ctx.namespace,
      githubRepo: ctx.githubRepo,
      gitRef: ctx.gitRef,
      runtime: ctx.runtime,
      strategy: ctx.strategy,
    },
    ctx.incidentId
  );
}

class InvestigatorBuildPlugin implements SourceBuildPlugin {
  id: string;
  strategy: SourceBuildStrategy;

  constructor(id: string, strategy: SourceBuildStrategy) {
    this.id = id;
    this.strategy = strategy;
  }

  isAvailable(): boolean {
    return sourceBuildEnabled();
  }

  async build(ctx: SourceBuildContext): Promise<SourceBuildResult> {
    return executeSourceBuildViaInvestigator(ctx);
  }
}

function createInvestigatorPlugin(
  id: string,
  strategy: SourceBuildStrategy
): SourceBuildPlugin {
  return new InvestigatorBuildPlugin(id, strategy);
}

class BuildpacksPlugin extends InvestigatorBuildPlugin {
  constructor() {
    super('buildpacks', 'buildpacks');
  }

  isAvailable(): boolean {
    return sourceBuildEnabled();
  }
}

class DockerfileKanikoPlugin extends InvestigatorBuildPlugin {
  constructor() {
    super('kaniko-dockerfile', 'existing-dockerfile');
  }
}

class S2iPlugin extends InvestigatorBuildPlugin {
  constructor() {
    super('s2i-openshift', 's2i');
  }

  isAvailable(): boolean {
    return (
      sourceBuildEnabled() && (process.env['OPENSHIFT_API_URL'] ?? '').length > 0
    );
  }
}

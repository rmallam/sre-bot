/**
 * Detect application runtime from a cloned repo directory (S2I / buildpack input).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoSignals } from '../types.js';

export type DetectedRuntime =
  | 'nodejs'
  | 'python'
  | 'go'
  | 'java'
  | 'ruby'
  | 'rust'
  | 'php'
  | 'unknown';

export type SourceBuildStrategy = 'existing-dockerfile' | 'buildpacks' | 's2i' | 'skip';

export function detectRuntime(repoDir: string): DetectedRuntime {
  if (existsSync(join(repoDir, 'package.json'))) return 'nodejs';
  if (
    existsSync(join(repoDir, 'requirements.txt')) ||
    existsSync(join(repoDir, 'pyproject.toml')) ||
    existsSync(join(repoDir, 'Pipfile'))
  ) {
    return 'python';
  }
  if (existsSync(join(repoDir, 'go.mod'))) return 'go';
  if (
    existsSync(join(repoDir, 'pom.xml')) ||
    existsSync(join(repoDir, 'build.gradle')) ||
    existsSync(join(repoDir, 'build.gradle.kts'))
  ) {
    return 'java';
  }
  if (existsSync(join(repoDir, 'Gemfile'))) return 'ruby';
  if (existsSync(join(repoDir, 'Cargo.toml'))) return 'rust';
  if (existsSync(join(repoDir, 'composer.json'))) return 'php';
  return 'unknown';
}

export function enrichRepoSignals(repoDir: string, base: RepoSignals = {}): RepoSignals {
  const hasDockerfile = base.hasDockerfile ?? existsSync(join(repoDir, 'Dockerfile'));
  const runtime = detectRuntime(repoDir);
  const needsImageBuild = !hasDockerfile && runtime !== 'unknown';

  let buildStrategy: SourceBuildStrategy = 'skip';
  if (hasDockerfile) buildStrategy = 'existing-dockerfile';
  else if (needsImageBuild) buildStrategy = pickBuildStrategy();

  return {
    ...base,
    hasDockerfile,
    hasPackageJson: base.hasPackageJson ?? existsSync(join(repoDir, 'package.json')),
    hasGoMod: base.hasGoMod ?? existsSync(join(repoDir, 'go.mod')),
    primaryLanguage: runtime === 'unknown' ? base.primaryLanguage ?? 'unknown' : runtime,
    detectedRuntime: runtime,
    needsImageBuild,
    buildStrategy,
  };
}

function pickBuildStrategy(): SourceBuildStrategy {
  const raw = (process.env['SOURCE_BUILD_STRATEGY'] ?? 'buildpacks').toLowerCase();
  if (raw === 's2i' || raw === 'openshift') return 's2i';
  if (raw === 'skip' || raw === 'none') return 'skip';
  return 'buildpacks';
}

export function defaultBuilderImage(runtime: DetectedRuntime): string | undefined {
  const map: Partial<Record<DetectedRuntime, string>> = {
    nodejs: process.env['BUILDPACK_NODE_BUILDER'] ?? 'paketobuildpacks/builder-jammy-base',
    python: process.env['BUILDPACK_PYTHON_BUILDER'] ?? 'paketobuildpacks/builder-jammy-base',
    go: process.env['BUILDPACK_GO_BUILDER'] ?? 'paketobuildpacks/builder-jammy-base',
    java: process.env['BUILDPACK_JAVA_BUILDER'] ?? 'paketobuildpacks/builder-jammy-base',
    ruby: process.env['BUILDPACK_RUBY_BUILDER'] ?? 'paketobuildpacks/builder-jammy-base',
  };
  return map[runtime];
}

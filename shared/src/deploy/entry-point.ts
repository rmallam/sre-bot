/**
 * Detect Kubernetes deploy entry points in a cloned repository directory.
 */

import { existsSync, readdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

export type DeployEntryPointKind = 'kustomize' | 'helm' | 'plain-yaml' | 'operator-install' | 'unknown';

export interface DeployEntryPoint {
  path: string;
  kind: DeployEntryPointKind;
}

const COMPOSE_YAML = new Set([
  'compose.yml',
  'compose.yaml',
  'docker-compose.yml',
  'docker-compose.yaml',
]);

/** YAML files that are not Kubernetes manifests (local dev / CI only). */
export function isNonK8sYamlFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (COMPOSE_YAML.has(lower)) return true;
  if (lower.includes('docker-compose')) return true;
  if (lower === 'kind-config.yaml' || lower === 'kind-config.yml') return true;
  if (lower.startsWith('.') ) return true;
  return false;
}

function chartCandidates(repoDir: string): string[] {
  const out: string[] = [];
  const direct = [
    join(repoDir, 'Chart.yaml'),
    join(repoDir, 'helm', 'Chart.yaml'),
    join(repoDir, 'charts', 'Chart.yaml'),
  ];
  for (const p of direct) {
    if (existsSync(p)) out.push(p);
  }
  for (const sub of ['helm', 'charts', 'deploy']) {
    const base = join(repoDir, sub);
    if (!existsSync(base)) continue;
    let entries: string[];
    try {
      entries = readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const chart = join(base, entry, 'Chart.yaml');
      if (existsSync(chart)) out.push(chart);
    }
  }
  return out;
}

function pickHelmChart(candidates: string[], appHint?: string): string | undefined {
  if (candidates.length === 0) return undefined;
  if (appHint) {
    const hint = appHint.toLowerCase().replace(/-operator$/, '');
    const match = candidates.find((c) => {
      const dir = basename(join(c, '..')).toLowerCase();
      return dir.includes(hint) || dir.includes(appHint.toLowerCase());
    });
    if (match) return match;
  }
  return candidates[0];
}

/**
 * Locate the best deploy entry point under a cloned repo root.
 * Prefers Helm (including nested charts) over Docker Compose YAML at repo root.
 */
export function detectDeployEntryPoint(repoDir: string, appHint?: string): DeployEntryPoint | null {
  const kustomizeCandidates = [
    join(repoDir, 'kustomization.yaml'),
    join(repoDir, 'kustomization.yml'),
    join(repoDir, 'base', 'kustomization.yaml'),
    join(repoDir, 'base', 'kustomization.yml'),
    join(repoDir, 'overlays', 'prod', 'kustomization.yaml'),
    join(repoDir, 'overlays', 'production', 'kustomization.yaml'),
    join(repoDir, 'k8s', 'kustomization.yaml'),
  ];
  for (const p of kustomizeCandidates) {
    if (existsSync(p)) return { path: p, kind: 'kustomize' };
  }

  const helm = pickHelmChart(chartCandidates(repoDir), appHint);
  if (helm) return { path: helm, kind: 'helm' };

  for (const name of ['install.yaml', 'install.yml']) {
    const p = join(repoDir, name);
    if (existsSync(p)) return { path: p, kind: 'operator-install' };
  }

  if (existsSync(join(repoDir, 'PROJECT')) && existsSync(join(repoDir, 'config', 'manager'))) {
    for (const name of ['manager.yaml', 'manager.yml']) {
      const p = join(repoDir, 'config', 'manager', name);
      if (existsSync(p)) return { path: p, kind: 'operator-install' };
    }
  }

  const searchDirs = [
    repoDir,
    join(repoDir, 'deploy'),
    join(repoDir, 'k8s'),
    join(repoDir, 'manifests'),
    join(repoDir, 'kubernetes'),
    join(repoDir, 'config'),
  ];

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const ext = extname(entry).toLowerCase();
      if (ext !== '.yaml' && ext !== '.yml') continue;
      if (isNonK8sYamlFile(entry)) continue;
      return { path: join(dir, entry), kind: 'plain-yaml' };
    }
  }

  return null;
}

export function isHelmChartPath(manifestPath?: string): boolean {
  return !!manifestPath && /(^|\/)Chart\.yaml$/i.test(manifestPath);
}

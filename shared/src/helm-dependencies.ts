/**
 * Ensure Helm chart subchart dependencies are vendored before template/upgrade.
 */

import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface HelmDependencyInfo {
  hasDependencies: boolean;
  vendored: boolean;
  names: string[];
}

/** Parse dependency names from Chart.yaml without requiring a YAML parser in shared. */
export function parseChartDependencies(chartYamlRaw: string): string[] {
  const names: string[] = [];
  const lines = chartYamlRaw.split('\n');
  let inDeps = false;
  for (const line of lines) {
    if (/^dependencies\s*:/i.test(line.trim())) {
      inDeps = true;
      continue;
    }
    if (inDeps && /^\S/.test(line) && !line.startsWith(' ')) {
      break;
    }
    if (inDeps) {
      const m = line.match(/^\s*-\s*name:\s*["']?([\w.-]+)/i);
      if (m?.[1]) names.push(m[1]);
    }
  }
  return names;
}

export function chartDependenciesVendored(chartDir: string): boolean {
  const chartsDir = join(chartDir, 'charts');
  if (!existsSync(chartsDir)) return false;
  try {
    const entries = readdirSync(chartsDir);
    return entries.some((e) => e.endsWith('.tgz') || (!e.startsWith('.') && e.length > 0));
  } catch {
    return false;
  }
}

export async function inspectHelmDependencies(chartDir: string): Promise<HelmDependencyInfo> {
  const chartPath = join(chartDir, 'Chart.yaml');
  if (!existsSync(chartPath)) {
    return { hasDependencies: false, vendored: false, names: [] };
  }
  const raw = await readFile(chartPath, 'utf-8');
  const names = parseChartDependencies(raw);
  return {
    hasDependencies: names.length > 0,
    vendored: chartDependenciesVendored(chartDir),
    names,
  };
}

/** True when helm output indicates missing vendored subcharts. */
export function isHelmDependencyError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    /missing in charts\/ directory/i.test(msg) ||
    /found in chart\.yaml, but missing/i.test(msg) ||
    /helm dependency build/i.test(msg) ||
    /an error occurred while checking for chart dependencies/i.test(msg)
  );
}

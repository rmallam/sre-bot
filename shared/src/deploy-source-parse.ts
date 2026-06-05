/**
 * Parse operator replies with deploy source details (repo, chart, argo app, hot-fix).
 */

import type { DeployMethod, DeployProvenance, FixSurface } from './deploy-provenance.js';
import { defaultFixSurface, mergeDeployProvenance } from './deploy-provenance.js';

export interface DeploySourceParseResult {
  provenance?: Partial<DeployProvenance>;
  allowClusterHotFix?: boolean;
  cancelled?: boolean;
}

function normalizeRepo(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/i, '')
    .replace(/^git@github\.com:/, 'github.com/');
}

export function parseDeploySourceReply(text: string): DeploySourceParseResult {
  const t = text.trim();
  if (!t) return {};
  if (/^(cancel|nevermind|never mind|stop)\b/i.test(t)) {
    return { cancelled: true };
  }
  if (/\b(hot[- ]?fix|cluster only|cluster hot[- ]?fix|patch cluster|live patch)\b/i.test(t)) {
    return {
      allowClusterHotFix: true,
      provenance: {
        method: 'direct-apply',
        fixSurface: 'cluster-live',
        confidence: 'high',
        source: 'user-provided',
        allowClusterHotFix: true,
      },
    };
  }

  const out: Partial<DeployProvenance> = {
    confidence: 'high',
    source: 'user-provided',
  };

  const repoMatch =
    t.match(/\brepo(?:sitory)?\s+([^\s]+)/i) ??
    t.match(/\bgithub\.com\/[\w.-]+\/[\w.-]+/i) ??
    t.match(/\b(?:org|owner)\/[\w.-]+\/[\w.-]+/i);
  if (repoMatch) {
    out.sourceRepo = normalizeRepo(repoMatch[1] ?? repoMatch[0]);
  }

  const chartMatch = t.match(/\bchart(?:\s+path)?\s+([^\s]+)/i);
  if (chartMatch) out.chartPath = chartMatch[1].replace(/\/$/, '');

  const manifestMatch = t.match(/\bmanifest(?:\s+path)?\s+([^\s]+)/i);
  if (manifestMatch) out.manifestPath = manifestMatch[1];

  const branchMatch =
    t.match(/\b(?:branch|ref|@)\s*([^\s]+)/i) ?? t.match(/\bon\s+branch\s+([^\s]+)/i);
  if (branchMatch) out.gitRef = branchMatch[1].replace(/^@/, '');

  const argoMatch = t.match(/\b(?:argocd|argo)\s+(?:app(?:lication)?\s+)?([^\s]+)/i);
  if (argoMatch) out.argoApp = argoMatch[1];

  const gitopsMatch = t.match(/\bgitops\s+repo\s+([^\s]+)/i);
  if (gitopsMatch) out.gitopsRepo = normalizeRepo(gitopsMatch[1]);

  const methodMatch = t.match(/\b(helm|kustomize|plain[- ]?yaml|argocd|operator|direct)\b/i);
  if (methodMatch) {
    const m = methodMatch[1].toLowerCase();
    out.method = (
      m === 'plain-yaml' || m === 'plain yaml'
        ? 'plain-yaml'
        : m === 'operator'
          ? 'operator-cr'
          : m === 'direct'
            ? 'direct-apply'
            : m
    ) as DeployMethod;
    out.fixSurface = defaultFixSurface(out.method);
  }

  const operatorCrMatch = t.match(/\boperator\s+cr\s+([^\s]+)/i);
  if (operatorCrMatch) {
    out.method = 'operator-cr';
    out.fixSurface = 'operator-cr';
    out.operatorCr = {
      apiVersion: 'unknown',
      kind: 'CustomResource',
      name: operatorCrMatch[1],
      namespace: 'default',
    };
  }

  if (!out.method && (out.chartPath || out.helmRelease)) out.method = 'helm';
  if (!out.method && out.argoApp) out.method = 'argocd';
  if (!out.method && out.manifestPath) out.method = 'plain-yaml';
  if (!out.method && out.sourceRepo) out.method = 'helm';

  if (out.method) {
    out.fixSurface = out.fixSurface ?? defaultFixSurface(out.method);
  }

  if (Object.keys(out).length <= 2) return {};
  return { provenance: out };
}

export function applyDeploySourceHints(
  base: DeployProvenance | undefined,
  parsed: DeploySourceParseResult
): DeployProvenance {
  return mergeDeployProvenance(base, parsed.provenance, {
    allowClusterHotFix: parsed.allowClusterHotFix,
  });
}

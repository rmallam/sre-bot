/**
 * Deployment provenance — how a workload was deployed and where to apply fixes.
 */

import type { ResourceKind } from './types.js';

export type DeployMethod =
  | 'helm'
  | 'kustomize'
  | 'plain-yaml'
  | 'argocd'
  | 'operator-cr'
  | 'direct-apply'
  | 'unknown';

export type DeployProvenanceSource =
  | 'agent-annotation'
  | 'cluster-labels'
  | 'git-mirror'
  | 'registry'
  | 'user-provided'
  | 'inferred';

export type FixSurface = 'gitops-repo' | 'app-repo' | 'cluster-live' | 'operator-cr';

export type ProvenanceConfidence = 'high' | 'medium' | 'low';

export interface HelmReleaseRef {
  name: string;
  namespace: string;
}

export interface OperatorCrRef {
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string;
}

export interface DeployProvenance {
  method: DeployMethod;
  confidence: ProvenanceConfidence;
  source: DeployProvenanceSource;
  fixSurface: FixSurface;
  missingFields: string[];
  sourceRepo?: string;
  chartPath?: string;
  gitRef?: string;
  manifestPath?: string;
  gitopsRepo?: string;
  argoApp?: string;
  helmRelease?: HelmReleaseRef;
  operatorCr?: OperatorCrRef;
  deployRunId?: string;
  allowClusterHotFix?: boolean;
}

export const SRE_BOT_ANNOTATIONS = {
  managed: 'sre-bot.io/managed',
  deployMethod: 'sre-bot.io/deploy-method',
  deployRunId: 'sre-bot.io/deploy-run-id',
  sourceRepo: 'sre-bot.io/source-repo',
  sourceRef: 'sre-bot.io/source-ref',
  manifestPath: 'sre-bot.io/manifest-path',
  chartPath: 'sre-bot.io/chart-path',
  gitopsRepo: 'sre-bot.io/gitops-repo',
  argoApp: 'sre-bot.io/argo-app',
} as const;

export function deploySourceRegistryKey(
  namespace: string,
  resourceKind: ResourceKind | string,
  resourceName: string
): string {
  return `deploy-source:${namespace}/${resourceKind}/${resourceName}`;
}

export function computeMissingFields(p: Partial<DeployProvenance>): string[] {
  const missing: string[] = [];
  const method = p.method ?? 'unknown';
  const fixSurface = p.fixSurface ?? 'gitops-repo';

  if (p.allowClusterHotFix) return [];

  if (method === 'unknown') {
    return [];
  }

  if (fixSurface === 'operator-cr') {
    if (!p.operatorCr?.name) missing.push('operatorCr');
    if (!p.sourceRepo && !p.manifestPath) missing.push('sourceRepo');
    return missing;
  }

  if (fixSurface === 'cluster-live') return [];

  const hasGitPath = Boolean(p.manifestPath?.trim() || p.chartPath?.trim());
  const hasRepo = Boolean(p.sourceRepo?.trim() || p.gitopsRepo?.trim());

  if (method === 'helm') {
    if (!hasRepo) missing.push('sourceRepo');
    if (hasRepo && !hasGitPath) missing.push('chartPath');
    if (!hasGitPath && !hasRepo) missing.push('chartPath');
    if (!p.gitRef?.trim()) missing.push('gitRef');
  } else if (method === 'argocd') {
    if (!p.argoApp?.trim() && !hasRepo) missing.push('argoApp');
    if (!hasRepo && !hasGitPath) missing.push('sourceRepo');
  } else if (method === 'kustomize' || method === 'plain-yaml') {
    if (!hasGitPath && !hasRepo) missing.push('manifestPath');
  } else if (method === 'direct-apply') {
    return [];
  }

  return [...new Set(missing)];
}

export function mergeDeployProvenance(
  ...parts: Array<Partial<DeployProvenance> | undefined>
): DeployProvenance {
  const merged: DeployProvenance = {
    method: 'unknown',
    confidence: 'low',
    source: 'inferred',
    fixSurface: 'gitops-repo',
    missingFields: [],
  };

  for (const part of parts) {
    if (!part) continue;
    if (part.method && part.method !== 'unknown') merged.method = part.method;
    if (part.confidence) merged.confidence = part.confidence;
    if (part.source) merged.source = part.source;
    if (part.fixSurface) merged.fixSurface = part.fixSurface;
    if (part.sourceRepo) merged.sourceRepo = part.sourceRepo;
    if (part.chartPath) merged.chartPath = part.chartPath;
    if (part.gitRef) merged.gitRef = part.gitRef;
    if (part.manifestPath) merged.manifestPath = part.manifestPath;
    if (part.gitopsRepo) merged.gitopsRepo = part.gitopsRepo;
    if (part.argoApp) merged.argoApp = part.argoApp;
    if (part.helmRelease) merged.helmRelease = part.helmRelease;
    if (part.operatorCr) merged.operatorCr = part.operatorCr;
    if (part.deployRunId) merged.deployRunId = part.deployRunId;
    if (part.allowClusterHotFix) merged.allowClusterHotFix = true;
  }

  merged.missingFields = computeMissingFields(merged);
  return merged;
}

export function isDeploySourceReady(p: DeployProvenance): boolean {
  return p.allowClusterHotFix === true || p.missingFields.length === 0;
}

export function needsDeploySourcePrompt(
  p: DeployProvenance | undefined,
  mode: string
): boolean {
  if (mode !== 'diagnose' || !p) return false;
  if (p.allowClusterHotFix) return false;
  if (p.fixSurface === 'cluster-live') return false;
  return p.missingFields.length > 0;
}

export function buildDeploySourcePrompt(
  namespace: string,
  resourceKind: string,
  resourceName: string,
  p: DeployProvenance
): string {
  const workload = `${namespace}/${resourceKind}/${resourceName}`;
  const lines: string[] = [
    `I need deploy source details to fix **${workload}** the same way it was deployed.`,
    '',
  ];

  if (p.method !== 'unknown') {
    lines.push(`Detected: **${p.method}** (${p.confidence} confidence, via ${p.source}).`);
  }
  if (p.helmRelease?.name) {
    lines.push(`Helm release: \`${p.helmRelease.namespace}/${p.helmRelease.name}\`.`);
  }
  if (p.argoApp) {
    lines.push(`Argo CD app hint: \`${p.argoApp}\`.`);
  }
  if (p.operatorCr?.name) {
    lines.push(`Operator CR: \`${p.operatorCr.kind}/${p.operatorCr.name}\`.`);
  }

  lines.push('', 'Please reply with:');
  const need = new Set(p.missingFields);

  if (need.has('deployMethod')) {
    lines.push('• How it was deployed: `helm`, `plain yaml`, `argocd`, or `operator`');
  }
  if (need.has('sourceRepo') || need.has('manifestPath')) {
    lines.push('• Source repo, e.g. `github.com/org/app`');
  }
  if (need.has('chartPath')) {
    lines.push('• Chart path, e.g. `deploy/helm/myapp`');
  }
  if (need.has('gitRef')) {
    lines.push('• Branch/ref, e.g. `main` or `@develop`');
  }
  if (need.has('argoApp')) {
    lines.push('• Argo CD Application name');
  }
  if (need.has('operatorCr')) {
    lines.push('• Operator CR name and API (if known)');
  }

  lines.push(
    '',
    'Example: `repo github.com/acme/payments chart deploy/helm/payments branch main`',
    '',
    'Or reply **`hot-fix cluster only`** for a temporary live patch (may drift from Git).',
    'Reply **`cancel`** to stop.'
  );

  return lines.join('\n');
}

export function provenanceFromRegistryMarkdown(
  markdown: string,
  key: string
): Partial<DeployProvenance> | null {
  const fm = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;

  const fields: Record<string, string> = {};
  for (const line of fm[1].split('\n')) {
    const m = line.match(/^([a-zA-Z0-9_]+):\s*"?([^"]*)"?\s*$/);
    if (m) fields[m[1]] = m[2].trim();
  }

  if (fields['registryKey'] && fields['registryKey'] !== key) return null;

  const method = (fields['method'] ?? 'unknown') as DeployMethod;
  const out: Partial<DeployProvenance> = {
    method,
    confidence: 'high',
    source: 'registry',
    fixSurface: (fields['fixSurface'] as FixSurface) ?? defaultFixSurface(method),
    sourceRepo: fields['sourceRepo'] || undefined,
    chartPath: fields['chartPath'] || undefined,
    gitRef: fields['gitRef'] || undefined,
    manifestPath: fields['manifestPath'] || undefined,
    gitopsRepo: fields['gitopsRepo'] || undefined,
    argoApp: fields['argoApp'] || undefined,
  };

  if (fields['helmReleaseName'] && fields['helmReleaseNamespace']) {
    out.helmRelease = {
      name: fields['helmReleaseName'],
      namespace: fields['helmReleaseNamespace'],
    };
  }

  if (fields['operatorCrKind'] && fields['operatorCrName']) {
    out.operatorCr = {
      apiVersion: fields['operatorCrApiVersion'] ?? 'unknown',
      kind: fields['operatorCrKind'],
      name: fields['operatorCrName'],
      namespace: fields['operatorCrNamespace'] ?? 'default',
    };
  }

  return out;
}

export function formatDeploySourceRegistryMarkdown(
  namespace: string,
  resourceKind: string,
  resourceName: string,
  p: DeployProvenance
): string {
  const key = deploySourceRegistryKey(namespace, resourceKind, resourceName);
  const lines = [
    '---',
    `registryKey: ${key}`,
    `method: ${p.method}`,
    `fixSurface: ${p.fixSurface}`,
  ];
  if (p.sourceRepo) lines.push(`sourceRepo: ${p.sourceRepo}`);
  if (p.chartPath) lines.push(`chartPath: ${p.chartPath}`);
  if (p.gitRef) lines.push(`gitRef: ${p.gitRef}`);
  if (p.manifestPath) lines.push(`manifestPath: ${p.manifestPath}`);
  if (p.gitopsRepo) lines.push(`gitopsRepo: ${p.gitopsRepo}`);
  if (p.argoApp) lines.push(`argoApp: ${p.argoApp}`);
  if (p.helmRelease) {
    lines.push(`helmReleaseName: ${p.helmRelease.name}`);
    lines.push(`helmReleaseNamespace: ${p.helmRelease.namespace}`);
  }
  if (p.operatorCr) {
    lines.push(`operatorCrApiVersion: ${p.operatorCr.apiVersion}`);
    lines.push(`operatorCrKind: ${p.operatorCr.kind}`);
    lines.push(`operatorCrName: ${p.operatorCr.name}`);
    lines.push(`operatorCrNamespace: ${p.operatorCr.namespace}`);
  }
  lines.push('---', '', `# Deploy source — ${namespace}/${resourceName}`, '');
  lines.push(`Workload \`${namespace}/${resourceKind}/${resourceName}\` managed via **${p.method}**.`);
  if (p.sourceRepo) lines.push(`- App repo: ${p.sourceRepo}`);
  if (p.chartPath) lines.push(`- Chart: ${p.chartPath}`);
  if (p.manifestPath) lines.push(`- Manifest: ${p.manifestPath}`);
  if (p.argoApp) lines.push(`- Argo app: ${p.argoApp}`);
  return lines.join('\n');
}

export function defaultFixSurface(method: DeployMethod): FixSurface {
  switch (method) {
    case 'helm':
    case 'kustomize':
    case 'plain-yaml':
    case 'argocd':
      return 'gitops-repo';
    case 'operator-cr':
      return 'operator-cr';
    case 'direct-apply':
      return 'cluster-live';
    default:
      return 'gitops-repo';
  }
}

export function parseProvenanceFromMetadata(
  labels: Record<string, string> | undefined,
  annotations: Record<string, string> | undefined
): Partial<DeployProvenance> | null {
  const ann = annotations ?? {};
  const lbl = labels ?? {};

  if (ann[SRE_BOT_ANNOTATIONS.managed] === 'true' || lbl['app.kubernetes.io/managed-by'] === 'sre-bot') {
    const method = (ann[SRE_BOT_ANNOTATIONS.deployMethod] ?? 'unknown') as DeployMethod;
    return {
      method: method !== 'unknown' ? method : 'plain-yaml',
      confidence: 'high',
      source: 'agent-annotation',
      fixSurface: defaultFixSurface(method),
      sourceRepo: ann[SRE_BOT_ANNOTATIONS.sourceRepo],
      chartPath: ann[SRE_BOT_ANNOTATIONS.chartPath],
      gitRef: ann[SRE_BOT_ANNOTATIONS.sourceRef],
      manifestPath: ann[SRE_BOT_ANNOTATIONS.manifestPath],
      gitopsRepo: ann[SRE_BOT_ANNOTATIONS.gitopsRepo],
      argoApp: ann[SRE_BOT_ANNOTATIONS.argoApp],
      deployRunId: ann[SRE_BOT_ANNOTATIONS.deployRunId],
    };
  }

  const helmRelease = ann['meta.helm.sh/release-name'];
  const helmNs = ann['meta.helm.sh/release-namespace'];
  if (helmRelease || lbl['app.kubernetes.io/managed-by'] === 'Helm') {
    return {
      method: 'helm',
      confidence: 'medium',
      source: 'cluster-labels',
      fixSurface: 'gitops-repo',
      helmRelease: helmRelease
        ? { name: helmRelease, namespace: helmNs ?? 'default' }
        : undefined,
    };
  }

  const argoInstance = lbl['argocd.argoproj.io/instance'];
  const argoTracking = ann['argocd.argoproj.io/tracking-id'];
  if (argoInstance || argoTracking) {
    return {
      method: 'argocd',
      confidence: 'medium',
      source: 'cluster-labels',
      fixSurface: 'gitops-repo',
      argoApp: argoInstance ?? argoTracking?.split('/')[0],
    };
  }

  return null;
}

export function buildProvenanceAnnotations(
  p: DeployProvenance,
  runId: string
): Record<string, string> {
  const ann: Record<string, string> = {
    [SRE_BOT_ANNOTATIONS.managed]: 'true',
    [SRE_BOT_ANNOTATIONS.deployMethod]: p.method,
    [SRE_BOT_ANNOTATIONS.deployRunId]: runId,
  };
  if (p.sourceRepo) ann[SRE_BOT_ANNOTATIONS.sourceRepo] = p.sourceRepo;
  if (p.chartPath) ann[SRE_BOT_ANNOTATIONS.chartPath] = p.chartPath;
  if (p.manifestPath) ann[SRE_BOT_ANNOTATIONS.manifestPath] = p.manifestPath;
  if (p.gitRef) ann[SRE_BOT_ANNOTATIONS.sourceRef] = p.gitRef;
  if (p.gitopsRepo) ann[SRE_BOT_ANNOTATIONS.gitopsRepo] = p.gitopsRepo;
  if (p.argoApp) ann[SRE_BOT_ANNOTATIONS.argoApp] = p.argoApp;
  return ann;
}

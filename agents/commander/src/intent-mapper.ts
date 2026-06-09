/**
 * Map CommandIntent → ParsedCommand (regex helpers for field extraction).
 */

import type { CommandIntent } from '../../../shared/src/command-intent.js';
import { normalizeGithubRepoSlug } from '../../../shared/src/git-ref.js';
import { normalizeDeployCommand } from '../../../shared/src/deploy-command.js';
import {
  parseCommand,
  parseSimpleDeploy,
  parseDelete,
  parseCi,
  parseWorkloadStatus,
  extractGithubRepo,
  parseEventInvestigation,
  parseAppInvestigation,
  type ParsedCommand,
  type DeployCmd,
  type InvestigateCmd,
  type WorkloadStatusCmd,
} from './parser.js';
import { isAllNamespacesScope, ALL_NAMESPACES } from '../../../shared/src/namespace-scope.js';
import { HELP_MESSAGE } from './help.js';
import {
  extractOperatorNamespaceHint,
  looksLikeKubernetesNamespace,
  resolveOperatorSuggestion,
  workloadHintFromNamespace,
} from './investigate-target.js';

export function commandIntentToParsed(intent: CommandIntent, text: string): ParsedCommand | null {
  switch (intent.intent) {
    case 'get':
      return intentGetToParsed(intent, text);
    case 'investigate':
      return intentInvestigateToParsed(intent, text);
    case 'deploy':
      return intentDeployToParsed(intent, text);
    case 'rollback': {
      const rb = parseCommand(text.includes('rollback') ? text : `rollback ${text}`);
      return rb.type === 'rollback' ? rb : null;
    }
    case 'delete':
      return intentDeleteToParsed(intent, text);
    case 'ci-failure':
      return intentCiToParsed(intent, text);
    case 'workload-status':
      return intentWorkloadStatusToParsed(intent, text);
    case 'help':
      return null;
    case 'chat':
      return null;
    default:
      return null;
  }
}

/** UX-12 — stable help text when intent is help. */
export function helpIntentReply(): string {
  return HELP_MESSAGE;
}

function intentGetToParsed(s: CommandIntent, text: string): ParsedCommand | null {
  const getParsed = parseCommand(text);
  if (getParsed.type === 'get') return getParsed;
  const rebuilt = parseCommand(
    `get ${s.getResource ?? 'pods'}${s.namespace ? ` in ${s.namespace}` : ''}`
  );
  return rebuilt.type === 'get' ? rebuilt : null;
}

function intentInvestigateToParsed(s: CommandIntent, text: string): InvestigateCmd | null {
  const eventCmd = parseEventInvestigation(text);
  if (eventCmd) return eventCmd;

  const appCmd = parseAppInvestigation(text);
  if (appCmd) return appCmd;

  const opNs = extractOperatorNamespaceHint(text);
  const scope = s.investigateScope ?? (s.workloadHint ? 'workload' : opNs ? 'namespace' : 'cluster');
  if (scope === 'app' && s.workloadHint) {
    return {
      type: 'investigate',
      scope: 'app',
      namespace: s.namespace?.trim() || opNs || 'default',
      resourceName: s.workloadHint.trim(),
      label: s.label ?? `app ${s.workloadHint.trim()}`,
    };
  }
  if (scope === 'cluster') {
    return {
      type: 'investigate',
      scope: 'cluster',
      namespace: '_all',
      resourceName: '_cluster',
      label: s.label ?? 'cluster health',
    };
  }
  const ns = s.namespace?.trim() || opNs;
  if (scope === 'namespace' && ns) {
    return {
      type: 'investigate',
      scope: 'namespace',
      namespace: ns,
      resourceName: '_namespace',
      label: s.label ?? `${ns} namespace`,
    };
  }
  if (s.workloadHint || opNs) {
    let hint = s.workloadHint?.trim() ?? '';
    if (!hint && opNs) hint = workloadHintFromNamespace(opNs);
    if (hint && looksLikeKubernetesNamespace(hint) && opNs) {
      hint = workloadHintFromNamespace(opNs);
    }
    const namespace = ns ?? (hint && looksLikeKubernetesNamespace(hint) ? hint : undefined) ?? 'default';
    const imageSuggestion = resolveOperatorSuggestion({
      text,
      workloadHint: hint || undefined,
      llmContainerImage: s.containerImage,
      llmOperatorSuggestion: s.operatorSuggestion,
    });
    return {
      type: 'investigate',
      scope: 'workload',
      namespace: opNs ?? namespace,
      resourceName: hint || '_unresolved',
      workloadHint: hint || undefined,
      label: s.label ?? (hint ? `${hint} deployment` : `${opNs} remediation`),
      operatorSuggestion: imageSuggestion,
    };
  }
  return null;
}

function intentDeployToParsed(s: CommandIntent, text: string): DeployCmd | null {
  const catalogDeploy = parseSimpleDeploy(text);
  if (catalogDeploy) {
    const llmNs = s.namespace?.trim();
    if (llmNs && catalogDeploy.namespace === 'default' && llmNs !== 'default') {
      return { ...catalogDeploy, namespace: llmNs };
    }
    return catalogDeploy;
  }

  const rawRepo = extractGithubRepo(text) ?? s.githubRepo;
  const githubRepo = rawRepo ? normalizeGithubRepoSlug(rawRepo) : null;
  if (!githubRepo) {
    if (s.workloadHint) {
      const hintDeploy = parseSimpleDeploy(
        text.toLowerCase().includes('deploy')
          ? text
          : `deploy ${s.workloadHint} in ${s.namespace ?? 'default'} namespace`
      );
      if (hintDeploy) return hintDeploy;
    }
    return null;
  }

  const regexDeploy = parseCommand(text.includes('deploy') ? text : `deploy ${text}`);
  const namespace =
    (s.namespace?.trim() || undefined) ??
    (regexDeploy.type === 'deploy' && regexDeploy.namespace?.trim()
      ? regexDeploy.namespace.trim()
      : undefined) ??
    '';
  const gitRef = s.gitRef ?? (regexDeploy.type === 'deploy' ? regexDeploy.gitRef : 'main');
  const directExplicit =
    s.deployStrategy === 'direct' ||
    (regexDeploy.type === 'deploy' && regexDeploy.deployStrategy === 'direct');

  return normalizeDeployCommand({
    type: 'deploy',
    githubRepo,
    gitRef,
    namespace,
    deployStrategy: directExplicit ? 'direct' : 'gitops',
    deployStrategyExplicit:
      !!s.deployStrategy ||
      (regexDeploy.type === 'deploy' && regexDeploy.deployStrategyExplicit),
  });
}

function intentDeleteToParsed(s: CommandIntent, text: string): ParsedCommand | null {
  const del = parseDelete(text);
  if (del) return del;
  if (s.workloadHint) {
    const rebuilt = parseDelete(
      text.toLowerCase().includes('delete') || text.toLowerCase().includes('remove')
        ? text
        : `delete ${s.workloadHint} from ${s.namespace ?? 'default'} namespace`
    );
    if (rebuilt) return rebuilt;
  }
  return null;
}

function intentCiToParsed(s: CommandIntent, text: string): ParsedCommand | null {
  const ci = parseCi(text);
  if (ci) return ci;
  if (s.githubRepo) {
    const repo = s.githubRepo.startsWith('github.com/')
      ? s.githubRepo
      : `github.com/${s.githubRepo}`;
    return {
      type: 'ci-failure',
      githubRepo: repo,
      gitRef: s.gitRef,
      label: s.label ?? `CI on ${repo.replace(/^github\.com\//, '')}`,
    };
  }
  return null;
}

function intentWorkloadStatusToParsed(s: CommandIntent, text: string): WorkloadStatusCmd | null {
  const fromRegex = parseWorkloadStatus(text);
  if (fromRegex) return fromRegex;

  const name = s.workloadHint?.trim();
  if (!name) return null;

  const allNs = isAllNamespacesScope(text) || s.namespace === 'any' || s.namespace === 'all';
  const ns = allNs
    ? ALL_NAMESPACES
    : s.namespace?.trim() || 'default';

  const kind =
    /\bpod\b/i.test(text) && !/\bdeployment\b/i.test(text) ? 'Pod' : 'Deployment';

  return {
    type: 'workload-status',
    resourceName: name,
    resourceKind: kind,
    namespace: ns,
    label: ns === ALL_NAMESPACES ? `${name} (all namespaces)` : `${name} in ${ns}`,
  };
}

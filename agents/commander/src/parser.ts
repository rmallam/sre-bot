// ─────────────────────────────────────────────────────────────────────────────
// src/parser.ts — Natural-language command parser (regex-first, human-friendly)
// ─────────────────────────────────────────────────────────────────────────────

import { listCatalogAppNames, resolveCatalogImage } from '../../../shared/src/app-image-catalog.js';

export type InvestigateScope = 'workload' | 'namespace' | 'cluster';

export interface DeployCmd {
  type: 'deploy';
  /** Required for Git-based deploys; omit when containerImage is set. */
  githubRepo: string;
  gitRef: string;
  namespace: string;
  deployStrategy: 'gitops' | 'direct';
  deployStrategyExplicit: boolean;
  /** Set after user approves namespace creation. */
  createNamespace?: boolean;
  /** Deploy from a public/catalog image without cloning a repo. */
  containerImage?: string;
  /** Kubernetes app name (defaults from image catalog token). */
  appName?: string;
  /** Multi-service deploy from several repositories in one run. */
  stackServices?: Array<{ name: string; githubRepo: string; gitRef?: string }>;
}

export interface InvestigateCmd {
  type: 'investigate';
  scope: InvestigateScope;
  namespace: string;
  resourceName: string;
  /** Short phrase for user-facing ack messages, e.g. "frappe deployment" */
  label: string;
  /** Original vague hint before cluster resolution (never a stop-word). */
  workloadHint?: string;
  resourceKind?: import('../../../shared/src/types.js').ResourceKind;
  podName?: string;
  /** Set after user confirms or auto-matched workload. */
  workloadConfirmed?: boolean;
}

export interface RollbackCmd {
  type: 'rollback';
  namespace: string;
  resourceName: string;
  label: string;
}

export interface DeleteCmd {
  type: 'delete';
  namespace: string;
  resourceName: string;
  label: string;
}

export type GetResource =
  | 'namespaces'
  | 'pods'
  | 'deployments'
  | 'nodes'
  | 'services'
  | 'events';

export interface GetCmd {
  type: 'get';
  resource: GetResource;
  namespace?: string;
  label: string;
}

export interface UnknownCmd {
  type: 'unknown';
}

export type ParsedCommand =
  | DeployCmd
  | InvestigateCmd
  | RollbackCmd
  | DeleteCmd
  | GetCmd
  | UnknownCmd;

const DELETE_RESERVED = new Set([
  'pod',
  'pods',
  'deployment',
  'deployments',
  'deploy',
  'namespace',
  'namespaces',
  'service',
  'services',
  'all',
  'everything',
  'this',
  'that',
]);

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'my',
  'our',
  'your',
  'this',
  'that',
  'please',
  'can',
  'you',
  'me',
  'is',
  'are',
  'was',
  'with',
  'for',
  'in',
  'on',
  'to',
  'of',
  'and',
  'or',
  'wrong',
  'broken',
  'bad',
  'failing',
  'issue',
  'issues',
  'problem',
  'problems',
  'help',
  'check',
  'look',
  'at',
  'investigate',
  'diagnose',
  'debug',
  'inspect',
  'what',
  'whats',
  "what's",
  'why',
  'how',
  'going',
  'happening',
  'deployment',
  'deployments',
  'deploy',
  'app',
  'application',
  'applications',
  'workload',
  'workloads',
  'service',
  'services',
  'pod',
  'pods',
  'namespace',
  'cluster',
  'health',
  'status',
  'overall',
  'everything',
  'all',
  'get',
  'list',
  'show',
  'display',
  'fix',
  'fixed',
  'remediate',
  'remediation',
  'repair',
  'patch',
  'change',
  'changing',
  'update',
  'updating',
  'image',
  'images',
  'tag',
  'tags',
  'container',
  'containers',
  'using',
  'use',
  'set',
  'by',
]);

const RESOURCE_ALIASES: Record<string, GetResource> = {
  namespace: 'namespaces',
  namespaces: 'namespaces',
  ns: 'namespaces',
  pod: 'pods',
  pods: 'pods',
  deployment: 'deployments',
  deployments: 'deployments',
  deploy: 'deployments',
  node: 'nodes',
  nodes: 'nodes',
  service: 'services',
  services: 'services',
  svc: 'services',
  event: 'events',
  events: 'events',
};

const INVESTIGATE_TRIGGERS =
  /(?:what(?:'?s| is)\s+wrong\s+with|investigate|diagnose|debug|why\s+is|why\s+are|check(?:\s+on|\s+out)?|look\s+at|inspect|how\s+is|how\s+are|health\s+of|status\s+of|any\s+issues\s+with)\s+/i;
const REMEDIATION_TRIGGERS = /\b(fix|remediate|repair|patch|change|update)\b/i;

export function extractGithubRepo(text: string): string | null {
  const match = text.match(
    /(?:https?:\/\/)?github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[\/\s#?]|$)/i
  );
  return match?.[1] != null ? `github.com/${match[1]}` : null;
}

export function extractGithubRepos(text: string): string[] {
  const re = /(?:https?:\/\/)?github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?=[\/\s#?]|$)/gi;
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const slug = m[1];
    if (!slug) continue;
    const repo = `github.com/${slug}`;
    if (!out.includes(repo)) out.push(repo);
  }
  return out;
}

function extractDeployNamespace(text: string): string {
  const flagMatch = text.match(/(?:--namespace|-n)\s+([\w-]+)/i);
  if (flagMatch?.[1]) return flagMatch[1];
  const toMatch = text.match(/\b(?:into|to)\s+namespace\s+([\w-]+)/i);
  if (toMatch?.[1]) return toMatch[1];
  const toNs = text.match(/\bto\s+([\w-]+)\s+namespace\b/i);
  if (toNs?.[1]) return toNs[1];
  const inNs = text.match(/\bin\s+(?:the\s+)?([\w-]+)\s+namespace\b/i);
  if (inNs?.[1]) return inNs[1];
  const fromNs = text.match(/\bfrom\s+(?:the\s+)?([\w-]+)(?:\s+namespace)?\b/i);
  if (fromNs?.[1] && !STOP_WORDS.has(fromNs[1].toLowerCase())) return fromNs[1];
  return 'default';
}

function extractDeployStrategy(text: string): { strategy: 'gitops' | 'direct'; explicit: boolean } {
  const direct =
    /\b(--direct|--no-git-push|--no-gitops-push)\b/i.test(text) ||
    /\b(no\s+git\s+push|without\s+git\s+push|don'?t\s+push\s+to\s+git|do\s+not\s+push\s+to\s+git)\b/i.test(
      text
    ) ||
    /\b(direct\s+deploy|deploy\s+directly|apply\s+directly)\b/i.test(text);
  if (direct) return { strategy: 'direct', explicit: true };
  const gitops = /\b(--gitops|gitops\s+mode|through\s+argocd)\b/i.test(text);
  if (gitops) return { strategy: 'gitops', explicit: true };
  return { strategy: 'gitops', explicit: false };
}

function extractGitRef(text: string): string {
  const onBranch = text.match(/\bon\s+branch\s+([\w./-]+)/i);
  if (onBranch?.[1]) return onBranch[1];
  const branchKw = text.match(/\bbranch\s+([\w./-]+)/i);
  if (branchKw?.[1]) return branchKw[1];
  const refMatch = text.match(/(?:@|--ref\s+|--branch\s+|--tag\s+)([\w./-]+)/i);
  return refMatch?.[1] ?? 'main';
}

function extractNamespaceHint(text: string): string | undefined {
  const slash = text.match(/\b([\w-]+)\/([\w-]+)\b/);
  if (slash) return slash[1];
  const inNs = text.match(/\bin\s+(?:the\s+)?([\w-]+)\s+namespace\b/i);
  if (inNs?.[1]) return inNs[1];
  const namedNs = text.match(/\b([\w-]+)\s+namespace\b/i);
  if (namedNs?.[1] && !STOP_WORDS.has(namedNs[1].toLowerCase())) return namedNs[1];
  const nsKw = text.match(/\bnamespace\s+([\w-]+)\b/i);
  if (nsKw?.[1]) return nsKw[1];
  return undefined;
}

function isClusterHealthQuery(text: string): boolean {
  if (/\b([\w-]+)\s+deployment\b/i.test(text) || /\bdeployment\s+([\w-]+)\b/i.test(text)) {
    return false;
  }
  return (
    /\b(cluster\s*(health|status|check|wide)|whole\s+cluster|entire\s+cluster)\b/i.test(text) ||
    /\b(my|our)\s+cluster\b/i.test(text) ||
    /\binvestigate\s+(my\s+)?cluster\b/i.test(text) ||
    /\b(cluster\s+health|health\s+of\s+(the\s+)?cluster)\b/i.test(text) ||
    /\b(how\s+is|how\s+are)\s+(things|everything)\b/i.test(text)
  );
}

function isNamespaceHealthQuery(text: string, namespace: string): boolean {
  const hasWorkload =
    /\b([\w-]+)\s+deployment\b/i.test(text) ||
    /\bdeployment\s+([\w-]+)\b/i.test(text) ||
    /\b[\w-]+\/[\w-]+\b/.test(text);
  if (hasWorkload) return false;
  return (
    /\b(namespace\s+health|health\s+of\s+(the\s+)?[\w-]+\s+namespace)\b/i.test(text) ||
    /\binvestigate\s+(the\s+)?[\w-]+\s+namespace\b/i.test(text) ||
    (/\b(health|status|check)\b/i.test(text) && /\bnamespace\b/i.test(text))
  );
}

function tokenizeSubject(raw: string): string[] {
  return raw
    .replace(/[^\w\s/-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t.toLowerCase()));
}

function extractRemediationWorkloadHint(text: string): string | undefined {
  const explicit = text.match(/\b(?:for|on|to)\s+([\w][\w.-]*)\b/i);
  if (explicit?.[1] && !STOP_WORDS.has(explicit[1].toLowerCase())) return explicit[1];

  const tokens = tokenizeSubject(text);
  const bad = new Set(['default', 'staging', 'prod', 'production', 'namespace']);
  const candidate = tokens.find((t) => !bad.has(t.toLowerCase()));
  return candidate;
}

function extractWorkloadName(text: string): { name: string; namespace?: string } | null {
  const slash = text.match(/\b([\w-]+)\/([\w-]+)\b/);
  if (slash) {
    return { namespace: slash[1], name: slash[2]! };
  }

  const depPatterns = [
    /\b(?:the\s+)?([\w][\w.-]*)\s+deployment\b/i,
    /\bdeployment\s+(?:named\s+)?([\w][\w.-]*)\b/i,
    /\b(?:the\s+)?([\w][\w.-]*)\s+(?:app|application|workload|service)\b/i,
    /\b(?:app|application|workload|service)\s+([\w][\w.-]*)\b/i,
  ];
  for (const re of depPatterns) {
    const m = text.match(re);
    if (m?.[1] && !STOP_WORDS.has(m[1].toLowerCase())) {
      return { name: m[1], namespace: extractNamespaceHint(text) };
    }
  }

  const afterTrigger = text.match(INVESTIGATE_TRIGGERS);
  if (afterTrigger) {
    const idx = text.search(INVESTIGATE_TRIGGERS);
    const tail = text.slice(idx + afterTrigger[0].length).trim();
    const tokens = tokenizeSubject(tail);
    if (tokens.length === 1) {
      return { name: tokens[0]!, namespace: extractNamespaceHint(text) };
    }
    if (tokens.length >= 1 && tokens[0]!.length >= 2) {
      return { name: tokens[0]!, namespace: extractNamespaceHint(text) };
    }
  }

  return null;
}

function parseInvestigate(text: string): InvestigateCmd | null {
  const normalised = text.trim();
  const remediationIntent =
    REMEDIATION_TRIGGERS.test(normalised) &&
    /\b(deployment|workload|app|application|service|pod|image|tag)\b/i.test(normalised);

  if (
    !INVESTIGATE_TRIGGERS.test(normalised) &&
    !/\b(cluster|namespace)\s+health\b/i.test(normalised) &&
    !remediationIntent
  ) {
    return null;
  }

  if (isClusterHealthQuery(normalised)) {
    return {
      type: 'investigate',
      scope: 'cluster',
      namespace: '_all',
      resourceName: '_cluster',
      label: 'cluster health',
    };
  }

  const nsHint = extractNamespaceHint(normalised);
  if (nsHint && isNamespaceHealthQuery(normalised, nsHint)) {
    return {
      type: 'investigate',
      scope: 'namespace',
      namespace: nsHint,
      resourceName: '_namespace',
      label: `${nsHint} namespace`,
    };
  }

  const nsOnly = extractNamespaceHint(normalised);
  if (
    nsOnly &&
    /\bnamespace\b/i.test(normalised) &&
    !remediationIntent &&
    !/\b([\w-]+)\s+deployment\b/i.test(normalised) &&
    !/\bdeployment\s+([\w-]+)\b/i.test(normalised)
  ) {
    return {
      type: 'investigate',
      scope: 'namespace',
      namespace: nsOnly,
      resourceName: '_namespace',
      label: `${nsOnly} namespace`,
    };
  }

  const workload = extractWorkloadName(normalised);
  if (workload?.name) {
    const namespace = workload.namespace ?? nsHint ?? 'default';
    return {
      type: 'investigate',
      scope: 'workload',
      namespace,
      resourceName: workload.name,
      workloadHint: workload.name,
      label: `${workload.name} in ${namespace}`,
    };
  }

  if (nsHint && /\b(health|status|check|wrong|issues)\b/i.test(normalised)) {
    return {
      type: 'investigate',
      scope: 'namespace',
      namespace: nsHint,
      resourceName: '_namespace',
      label: `${nsHint} namespace`,
    };
  }

  if (remediationIntent) {
    const hint = extractRemediationWorkloadHint(normalised);
    return {
      type: 'investigate',
      scope: 'workload',
      namespace: nsHint ?? 'default',
      resourceName: hint ?? '_unresolved',
      workloadHint: hint,
      label: hint ? `${hint} remediation` : 'remediation request',
    };
  }

  return {
    type: 'investigate',
    scope: 'workload',
    namespace: nsHint ?? 'default',
    resourceName: '_unresolved',
    workloadHint: undefined,
    label: 'your request',
  };
}

function extractNamespaceAndResource(
  text: string,
  anchorWord?: string
): { namespace: string; resourceName: string; label: string } {
  const flagMatch = text.match(/(?:--namespace|-n)\s+([\w-]+)\s+([\w-]+)/i);
  if (flagMatch) {
    return {
      namespace: flagMatch[1]!,
      resourceName: flagMatch[2]!,
      label: `${flagMatch[1]}/${flagMatch[2]}`,
    };
  }

  const slashMatch = text.match(/([\w-]+)\/([\w-]+)/);
  if (slashMatch) {
    return {
      namespace: slashMatch[1]!,
      resourceName: slashMatch[2]!,
      label: `${slashMatch[1]}/${slashMatch[2]}`,
    };
  }

  if (anchorWord) {
    const escapedAnchor = anchorWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const afterAnchor = text.match(new RegExp(`${escapedAnchor}\\s+([\\w/-]+)`, 'i'));
    if (afterAnchor) {
      const token = afterAnchor[1]!.split(/\s+/)[0]!;
      if (token.includes('/')) {
        const [ns, res] = token.split('/');
        return { namespace: ns!, resourceName: res!, label: `${ns}/${res}` };
      }
      if (!STOP_WORDS.has(token.toLowerCase())) {
        return { namespace: 'default', resourceName: token, label: token };
      }
    }
  }

  return { namespace: 'default', resourceName: 'unknown', label: 'unknown' };
}

/** Deploy by app name + image catalog, e.g. "deploy httpd in simple namespace". */
export function parseSimpleDeploy(text: string): DeployCmd | null {
  const normalised = text.trim();
  if (!/\bdeploy\b/i.test(normalised)) return null;
  if (extractGithubRepo(normalised)) return null;

  const withContainer = normalised.match(
    /\bdeploy\s+(?:the\s+)?([a-z0-9][a-z0-9.-]*)\s+container\b/i
  );
  const bare = normalised.match(/\bdeploy\s+(?:the\s+)?([a-z0-9][a-z0-9.-]*)\b/i);
  const appToken = (withContainer?.[1] ?? bare?.[1])?.toLowerCase();
  if (!appToken || STOP_WORDS.has(appToken) || appToken === 'container') {
    return null;
  }

  const image = resolveCatalogImage(appToken);
  if (!image) return null;

  const namespace = extractDeployNamespace(normalised);
  return {
    type: 'deploy',
    githubRepo: '',
    gitRef: 'main',
    namespace,
    deployStrategy: 'direct',
    deployStrategyExplicit: true,
    containerImage: image,
    appName: appToken === 'https' ? 'httpd' : appToken,
  };
}

/** Helpful hint when user said deploy but we could not parse repo or catalog app. */
export function deployParseHint(text: string): string | null {
  if (!/\bdeploy\b/i.test(text) || extractGithubRepo(text)) return null;

  const withContainer = text.match(/\bdeploy\s+(?:the\s+)?([a-z0-9][a-z0-9.-]*)\s+container\b/i);
  const bare = text.match(/\bdeploy\s+(?:the\s+)?([a-z0-9][a-z0-9.-]*)\b/i);
  const appToken = (withContainer?.[1] ?? bare?.[1])?.toLowerCase();
  const ns = extractDeployNamespace(text);

  if (appToken && !STOP_WORDS.has(appToken) && appToken !== 'container' && !resolveCatalogImage(appToken)) {
    return (
      `I don't have a built-in image for "${appToken}".\n\n` +
      `Try:\n` +
      `• deploy httpd in ${ns} namespace\n` +
      `• deploy github.com/org/${appToken} in ${ns} namespace\n\n` +
      `Built-in apps: ${listCatalogAppNames().join(', ')}`
    );
  }

  return (
    `To deploy, try:\n` +
    `• deploy httpd in ${ns} namespace\n` +
    `• deploy github.com/org/repo in ${ns} namespace\n\n` +
    `Built-in apps: ${listCatalogAppNames().join(', ')}`
  );
}

export function parseCommand(text: string): ParsedCommand {
  const normalised = text.trim();

  const simpleDeploy = parseSimpleDeploy(normalised);
  if (simpleDeploy) return simpleDeploy;

  const githubRepos = extractGithubRepos(normalised);
  const githubRepo = githubRepos[0] ?? null;
  const investigateIntent =
    INVESTIGATE_TRIGGERS.test(normalised) || /\bcluster\s+health\b/i.test(normalised);
  if (githubRepo !== null && !investigateIntent) {
    const gitRef = extractGitRef(normalised);
    const namespace = extractDeployNamespace(normalised);
    const strategy = extractDeployStrategy(normalised);
    const stackServices =
      githubRepos.length > 1
        ? githubRepos.map((repo) => ({
            name: repo.split('/').pop() ?? 'service',
            githubRepo: repo,
            gitRef,
          }))
        : undefined;
    return {
      type: 'deploy',
      githubRepo,
      gitRef,
      namespace,
      deployStrategy: strategy.strategy,
      deployStrategyExplicit: strategy.explicit,
      stackServices,
      appName: stackServices ? 'microservice-stack' : undefined,
    };
  }

  if (/\brollback\b/i.test(normalised)) {
    const { namespace, resourceName, label } = extractNamespaceAndResource(normalised, 'rollback');
    return { type: 'rollback', namespace, resourceName, label };
  }

  const deleteCmd = parseDelete(normalised);
  if (deleteCmd) {
    return deleteCmd;
  }

  const getCmd = parseGet(normalised);
  if (getCmd) {
    return getCmd;
  }

  const investigate = parseInvestigate(normalised);
  if (investigate) {
    return investigate;
  }

  const slashOnly = normalised.match(/^([\w-]+)\/([\w-]+)$/);
  if (slashOnly) {
    return {
      type: 'investigate',
      scope: 'workload',
      namespace: slashOnly[1]!,
      resourceName: slashOnly[2]!,
      label: `${slashOnly[1]}/${slashOnly[2]}`,
    };
  }

  return { type: 'unknown' };
}

/** True when regex found investigate intent but could not resolve a workload name. */
function parseResourceToken(token: string): GetResource | null {
  return RESOURCE_ALIASES[token.toLowerCase()] ?? null;
}

/** delete|remove|uninstall httpd from default namespace */
export function parseDelete(text: string): DeleteCmd | null {
  if (!/\b(?:delete|remove|uninstall|destroy|tear\s*down|undeploy)\b/i.test(text)) {
    return null;
  }

  const workload =
    text.match(
      /\b(?:delete|remove|uninstall|undeploy|destroy)\s+(?:the\s+)?([\w-]+)(?:\s+(?:app|deployment|deploy|release|service))?\b/i
    )?.[1] ??
    text.match(/\b(?:delete|remove|uninstall)\s+([\w-]+)\s+from\b/i)?.[1];

  if (!workload) return null;
  const resourceName = workload.toLowerCase();
  if (DELETE_RESERVED.has(resourceName)) return null;

  const namespace = extractDeployNamespace(text);
  return {
    type: 'delete',
    namespace,
    resourceName,
    label: `${resourceName} in ${namespace}`,
  };
}

function parseGet(text: string): GetCmd | null {
  const kubectl = text.match(
    /\bkubectl\s+get\s+(namespaces?|ns|pods?|deployments?|deploy|nodes?|services?|svc|events?)(?:\s+-n\s+|\s+--namespace\s+)([\w-]+)/i
  );
  if (kubectl) {
    const res = parseResourceToken(kubectl[1]!);
    if (res) {
      return {
        type: 'get',
        resource: res,
        namespace: kubectl[2],
        label: `${res} in ${kubectl[2]}`,
      };
    }
  }

  const kubectlAll = text.match(
    /\bkubectl\s+get\s+(namespaces?|ns|pods?|deployments?|deploy|nodes?|services?|svc|events?)\b/i
  );
  if (kubectlAll) {
    const res = parseResourceToken(kubectlAll[1]!);
    if (res) {
      return {
        type: 'get',
        resource: res,
        namespace: extractNamespaceHint(text),
        label: res,
      };
    }
  }

  const direct = text.match(
    /\b(?:get|list|show|display)(?:\s+me)?(?:\s+all)?\s+(namespaces?|ns|pods?|deployments?|deploy|nodes?|services?|svc|events?)\b/i
  );
  if (direct) {
    const res = parseResourceToken(direct[1]!);
    if (!res) return null;
    const ns =
      extractNamespaceHint(text) ??
      (text.match(/\b(?:in|from)\s+(?:the\s+)?([\w-]+)\s+namespace\b/i)?.[1] ??
        text.match(/\b(?:in|from)\s+(?:namespace\s+)?([\w-]+)\b/i)?.[1]);
    const namespace = ns && !STOP_WORDS.has(ns.toLowerCase()) ? ns : undefined;
    return {
      type: 'get',
      resource: res,
      namespace: res === 'namespaces' || res === 'nodes' ? undefined : namespace,
      label: namespace ? `${res} in ${namespace}` : res,
    };
  }

  const reversed = text.match(
    /\b(pods?|deployments?|services?|events?)\s+(?:in|from)\s+(?:the\s+)?([\w-]+)(?:\s+namespace)?\b/i
  );
  if (reversed) {
    const res = parseResourceToken(reversed[1]!);
    const ns = reversed[2];
    if (res && ns && !STOP_WORDS.has(ns.toLowerCase())) {
      return { type: 'get', resource: res, namespace: ns, label: `${res} in ${ns}` };
    }
  }

  return null;
}

export function investigateNeedsLlmResolution(parsed: ParsedCommand): boolean {
  return (
    parsed.type === 'investigate' &&
    (parsed.resourceName === '_unresolved' ||
      parsed.resourceName === 'unknown' ||
      STOP_WORDS.has(parsed.resourceName.toLowerCase()))
  );
}

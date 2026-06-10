/**
 * Pre-dispatch deploy confidence gate — combines routing confidence, regex agreement,
 * and field-quality signals before POST /runs.
 */

import {
  type DeployCommandInput,
  defaultDeployNamespace,
  deriveDeployAppName,
  normalizeDeployCommand,
} from './deploy-command.js';
import { normalizeGithubRepoSlug } from './git-ref.js';

export type DeployRoutingSource = 'llm' | 'regex' | 'platform' | 'followup' | 'clarification';

export interface DeployConfidenceInput {
  rawText: string;
  deploy: DeployCommandInput;
  routingConfidence?: number;
  routingSource?: DeployRoutingSource;
  /** Regex parser view of the same utterance (commander passes parseCommand result). */
  regexDeploy?: Pick<
    DeployCommandInput,
    'githubRepo' | 'namespace' | 'gitRef' | 'appName' | 'containerImage' | 'helmRemote'
  >;
  /** Raw githubRepo from LLM JSON before normalization (detect malformed URLs). */
  llmRawGithubRepo?: string;
}

export interface DeployConfidenceSignal {
  name: string;
  weight: number;
  score: number;
}

export interface DeployConfidenceResult {
  ok: boolean;
  score: number;
  threshold: number;
  signals: DeployConfidenceSignal[];
  reasons: string[];
  clarifyMessage?: string;
}

export function deployConfidenceThreshold(): number {
  const raw = process.env['DEPLOY_CONFIDENCE_THRESHOLD'] ?? '0.75';
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.75;
}

/** True when the user explicitly named a namespace in natural language. */
export function rawTextHasExplicitNamespace(text: string): boolean {
  const t = text.trim();
  if (/\b(?:to|in|into)\s+[\w.-]+\s+namespace\b/i.test(t)) return true;
  if (/--namespace\s+\S+/i.test(t)) return true;
  if (/\bnamespace\s*[:=]\s*[\w.-]+/i.test(t)) return true;
  return false;
}

function routingSignal(
  confidence: number | undefined,
  source: DeployRoutingSource | undefined
): DeployConfidenceSignal {
  let score: number;
  if (confidence != null && Number.isFinite(confidence)) {
    score = Math.max(0, Math.min(1, confidence));
  } else {
    switch (source) {
      case 'regex':
        score = 0.88;
        break;
      case 'platform':
        score = 0.82;
        break;
      case 'followup':
      case 'clarification':
        score = 0.94;
        break;
      case 'llm':
      default:
        score = 0.65;
        break;
    }
  }
  return { name: 'routing', weight: 0.35, score };
}

function regexAgreementSignal(
  regexDeploy: DeployConfidenceInput['regexDeploy'],
  deploy: DeployCommandInput,
  rawText: string,
  reasons: string[]
): DeployConfidenceSignal {
  let score = 0;

  if (
    !regexDeploy?.githubRepo?.trim() &&
    !regexDeploy?.containerImage?.trim() &&
    !regexDeploy?.helmRemote
  ) {
    const hasGithubUrl = /github\.com\/[\w.-]+\/[\w.-]+/i.test(rawText);
    score = hasGithubUrl ? 0.72 : 0.45;
    if (!hasGithubUrl) reasons.push('no_regex_deploy');
    return { name: 'regex_agreement', weight: 0.4, score };
  }

  const normRegex = normalizeDeployCommand({
    type: 'deploy',
    githubRepo: regexDeploy.githubRepo ?? '',
    gitRef: regexDeploy.gitRef ?? 'main',
    namespace: regexDeploy.namespace ?? '',
    deployStrategy: 'gitops',
    deployStrategyExplicit: false,
    containerImage: regexDeploy.containerImage,
    helmRemote: regexDeploy.helmRemote,
    appName: regexDeploy.appName,
  });

  if (normRegex.githubRepo && deploy.githubRepo) {
    if (normRegex.githubRepo === deploy.githubRepo) {
      score += 0.45;
      reasons.push('repo_match');
    } else {
      score += 0.12;
      reasons.push('repo_mismatch');
    }
  } else if (deploy.containerImage && regexDeploy.containerImage) {
    if (deploy.containerImage === regexDeploy.containerImage) {
      score += 0.45;
      reasons.push('image_match');
    } else {
      score += 0.15;
      reasons.push('image_mismatch');
    }
  } else if (deploy.helmRemote && regexDeploy.helmRemote) {
    if (deploy.helmRemote.chartRef === regexDeploy.helmRemote.chartRef) {
      score += 0.45;
      reasons.push('helm_catalog_match');
    } else {
      score += 0.15;
      reasons.push('helm_catalog_mismatch');
    }
  }

  const deployNs = deploy.namespace?.trim() ?? '';
  const regexNs = normRegex.namespace?.trim() ?? '';
  if (regexNs && deployNs && regexNs === deployNs) {
    score += 0.3;
    reasons.push('namespace_match');
  } else if (!rawTextHasExplicitNamespace(rawText)) {
    const inferred = defaultDeployNamespace(deriveDeployAppName(deploy));
    if (deployNs === inferred) {
      score += 0.22;
      reasons.push('namespace_inferred_ok');
    } else {
      score += 0.08;
      reasons.push('namespace_mismatch');
    }
  } else if (regexNs === deployNs) {
    score += 0.28;
  } else {
    score += 0.1;
    reasons.push('namespace_mismatch');
  }

  const regexRef = normRegex.gitRef?.trim() || 'main';
  const deployRef = deploy.gitRef?.trim() || 'main';
  if (regexRef === deployRef) {
    score += 0.25;
    reasons.push('ref_match');
  } else {
    score += 0.12;
    reasons.push('ref_mismatch');
  }

  return { name: 'regex_agreement', weight: 0.4, score: Math.min(1, score) };
}

function fieldQualitySignal(
  deploy: DeployCommandInput,
  rawText: string,
  reasons: string[],
  llmRawGithubRepo?: string
): DeployConfidenceSignal {
  let score = 1;

  const rawRepo = llmRawGithubRepo?.trim();
  if (rawRepo) {
    const normalized = normalizeGithubRepoSlug(rawRepo);
    if (rawRepo !== normalized) {
      score -= 0.2;
      reasons.push('malformed_repo_normalized');
    }
    if (/github\.com\/https?:\/\//i.test(rawRepo)) {
      score -= 0.3;
      reasons.push('double_prefixed_repo');
    }
  }

  if (!rawTextHasExplicitNamespace(rawText)) {
    const appName = deriveDeployAppName(deploy);
    if (deploy.namespace === defaultDeployNamespace(appName)) {
      score -= 0.08;
      reasons.push('namespace_defaulted');
    }
  }

  if (!deploy.githubRepo?.trim() && !deploy.containerImage?.trim() && !deploy.helmRemote) {
    score -= 0.5;
    reasons.push('missing_source');
  }

  return { name: 'field_quality', weight: 0.25, score: Math.max(0, Math.min(1, score)) };
}

function weightedScore(signals: DeployConfidenceSignal[]): number {
  const totalWeight = signals.reduce((s, sig) => s + sig.weight, 0);
  if (totalWeight <= 0) return 0;
  const sum = signals.reduce((s, sig) => s + sig.weight * sig.score, 0);
  return sum / totalWeight;
}

function buildClarifyMessage(deploy: DeployCommandInput, reasons: string[]): string {
  const repo =
    deploy.githubRepo?.replace(/^github\.com\//, '') ||
    deploy.helmRemote?.chartRef ||
    deploy.containerImage ||
    '(unknown repo)';
  const ns = deploy.namespace || '(unknown namespace)';
  const ref = deploy.gitRef || 'main';

  const mismatch = reasons.some((r) => r.endsWith('_mismatch'));
  const intro = mismatch
    ? "I'm not sure I parsed your deploy request correctly."
    : "I need a quick confirmation before starting this deploy.";

  return (
    `${intro}\n\n` +
    `Please confirm or correct:\n` +
    `• **Repository:** \`${repo}\`\n` +
    `• **Namespace:** \`${ns}\`\n` +
    `• **Branch/ref:** \`${ref}\`\n\n` +
    `Example: \`deploy ${repo} to ${ns} namespace on branch ${ref}\``
  );
}

export function evaluateDeployConfidence(input: DeployConfidenceInput): DeployConfidenceResult {
  const threshold = deployConfidenceThreshold();
  const source = input.routingSource ?? 'llm';
  const reasons: string[] = [];

  const signals: DeployConfidenceSignal[] = [
    routingSignal(input.routingConfidence, source),
    regexAgreementSignal(input.regexDeploy, input.deploy, input.rawText, reasons),
    fieldQualitySignal(input.deploy, input.rawText, reasons, input.llmRawGithubRepo),
  ];

  const score = weightedScore(signals);
  if (signals[0]!.score < 0.55) reasons.push('routing_low');
  if (signals[1]!.score < 0.55) reasons.push('regex_agreement_weak');

  const ok = score >= threshold;
  return {
    ok,
    score,
    threshold,
    signals,
    reasons,
    clarifyMessage: ok ? undefined : buildClarifyMessage(input.deploy, reasons),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// src/parser.ts — Natural-language command parser (regex-only, no AI)
//
// The AI reasoning lives in brain-agent. This module extracts intent and
// structured parameters from free-form user text so the router can dispatch
// the right downstream call.
// ─────────────────────────────────────────────────────────────────────────────

// ── Result types ──────────────────────────────────────────────────────────────

export interface DeployCmd {
  type: 'deploy';
  githubRepo: string; // e.g. "github.com/org/repo"
  gitRef: string;     // branch/tag, defaults to "main"
  namespace: string;
  deployStrategy: 'gitops' | 'direct';
  deployStrategyExplicit: boolean;
}

export interface InvestigateCmd {
  type: 'investigate';
  namespace: string;
  resourceName: string;
}

export interface RollbackCmd {
  type: 'rollback';
  namespace: string;
  resourceName: string;
}

export interface UnknownCmd {
  type: 'unknown';
}

export type ParsedCommand = DeployCmd | InvestigateCmd | RollbackCmd | UnknownCmd;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract a GitHub repo URL from text.
 * Accepts:
 *   https://github.com/org/repo
 *   github.com/org/repo
 * Returns the canonical "github.com/org/repo" form.
 */
export function extractGithubRepo(text: string): string | null {
  // Match URLs with optional https:// prefix, capturing org/repo
  const match = text.match(
    /(?:https?:\/\/)?github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[\/\s#?]|$)/i
  );
  return match?.[1] != null ? `github.com/${match[1]}` : null;
}

function extractDeployNamespace(text: string): string {
  const flagMatch = text.match(/(?:--namespace|-n)\s+([\w-]+)/i);
  if (flagMatch?.[1]) return flagMatch[1];
  const toMatch = text.match(/\b(?:into|to)\s+namespace\s+([\w-]+)/i);
  if (toMatch?.[1]) return toMatch[1];
  const toNs = text.match(/\bto\s+([\w-]+)\s+namespace\b/i);
  if (toNs?.[1]) return toNs[1];
  return 'default';
}

function extractDeployStrategy(text: string): { strategy: 'gitops' | 'direct'; explicit: boolean } {
  const direct = /\b(--direct|--no-git-push|--no-gitops-push)\b/i.test(text)
    || /\b(no\s+git\s+push|without\s+git\s+push|don'?t\s+push\s+to\s+git|do\s+not\s+push\s+to\s+git)\b/i.test(text)
    || /\b(direct\s+deploy|deploy\s+directly|apply\s+directly)\b/i.test(text);
  if (direct) return { strategy: 'direct', explicit: true };
  const gitops = /\b(--gitops|gitops\s+mode|through\s+argocd)\b/i.test(text);
  if (gitops) return { strategy: 'gitops', explicit: true };
  return { strategy: 'gitops', explicit: false };
}

/**
 * Extract a git ref (branch or tag) following @, --ref, --branch, or --tag.
 * Falls back to "main".
 */
function extractGitRef(text: string): string {
  const onBranch = text.match(/\bon\s+branch\s+([\w./-]+)/i);
  if (onBranch?.[1]) return onBranch[1];
  const branchKw = text.match(/\bbranch\s+([\w./-]+)/i);
  if (branchKw?.[1]) return branchKw[1];
  const refMatch = text.match(/(?:@|--ref\s+|--branch\s+|--tag\s+)([\w./-]+)/i);
  return refMatch?.[1] ?? 'main';
}

/**
 * Extract namespace and resource name from a string like:
 *   "production/api-server"  → { namespace: "production", resourceName: "api-server" }
 *   "api-server"             → { namespace: "default",    resourceName: "api-server" }
 *
 * Also accepts:
 *   "--namespace production api-server"
 *   "-n production api-server"
 */
function extractNamespaceAndResource(
  text: string,
  anchorWord?: string
): { namespace: string; resourceName: string } {
  // Explicit --namespace/-n flag
  const flagMatch = text.match(/(?:--namespace|-n)\s+([\w-]+)\s+([\w-]+)/i);
  if (flagMatch) {
    return { namespace: flagMatch[1]!, resourceName: flagMatch[2]! };
  }

  // "namespace/resource" slash notation
  const slashMatch = text.match(/([\w-]+)\/([\w-]+)/);
  if (slashMatch) {
    return { namespace: slashMatch[1]!, resourceName: slashMatch[2]! };
  }

  // Fall back to a bare word after the trigger word (e.g. "what's wrong with api-server")
  if (anchorWord) {
    const escapedAnchor = anchorWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const afterAnchor = text.match(new RegExp(`${escapedAnchor}\\s+([\\w/-]+)`, 'i'));
    if (afterAnchor) {
      const token = afterAnchor[1]!;
      if (token.includes('/')) {
        const [ns, res] = token.split('/');
        return { namespace: ns!, resourceName: res! };
      }
      return { namespace: 'default', resourceName: token };
    }
  }

  return { namespace: 'default', resourceName: 'unknown' };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * parseCommand — pure regex-based intent extraction.
 *
 * Priority (highest → lowest):
 *  1. Text contains a GitHub URL            → deploy
 *  2. Text contains "rollback"              → rollback
 *  3. Text contains investigate keywords    → investigate
 *  4. Everything else                       → unknown
 */
export function parseCommand(text: string): ParsedCommand {
  const normalised = text.trim();

  // ── 1. Deploy: GitHub URL present (unless explicitly an investigate message) ──
  const githubRepo = extractGithubRepo(normalised);
  const investigateIntent =
    /\binvestigate\b|\bdiagnose\b|\bdebug\b|what(?:'?s| is)\s+wrong/i.test(normalised);
  if (githubRepo !== null && !investigateIntent) {
    const gitRef = extractGitRef(normalised);
    const namespace = extractDeployNamespace(normalised);
    const strategy = extractDeployStrategy(normalised);
    return {
      type: 'deploy',
      githubRepo,
      gitRef,
      namespace,
      deployStrategy: strategy.strategy,
      deployStrategyExplicit: strategy.explicit,
    };
  }

  // ── 2. Rollback ────────────────────────────────────────────────────────────
  if (/\brollback\b/i.test(normalised)) {
    const { namespace, resourceName } = extractNamespaceAndResource(normalised, 'rollback');
    return { type: 'rollback', namespace, resourceName };
  }

  // ── 3. Investigate ────────────────────────────────────────────────────────
  // Trigger phrases: "what's wrong with", "investigate", "diagnose", "debug",
  // "why is X", "check X", "look at X", "whats wrong"
  const investigateTrigger =
    /(?:what(?:'?s|is)\s+wrong\s+with|investigate|diagnose|debug|why\s+is|check|look\s+at|inspect)\s+/i;
  if (investigateTrigger.test(normalised)) {
    // Find the anchor word that triggered the match so we can extract the resource
    const anchorMatch = normalised.match(investigateTrigger);
    const anchor = anchorMatch?.[0]?.trim() ?? 'investigate';
    const { namespace, resourceName } = extractNamespaceAndResource(normalised, anchor);
    return { type: 'investigate', namespace, resourceName };
  }

  // ── 4. Fallback ───────────────────────────────────────────────────────────
  return { type: 'unknown' };
}

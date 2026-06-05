/**
 * UX-3 — Single schema for commander intent routing (LLM + docs).
 * Commander maps this to ParsedCommand via intent-mapper.
 */

export type CommandIntentName =
  | 'investigate'
  | 'deploy'
  | 'rollback'
  | 'delete'
  | 'get'
  | 'ci-failure'
  | 'workload-status'
  | 'help'
  | 'chat';

export type CommandInvestigateScope = 'cluster' | 'namespace' | 'workload';

export interface CommandIntent {
  intent: CommandIntentName;
  /** Model self-reported confidence 0–1. */
  confidence: number;
  /** Short user-facing reply (greeting, clarification, or brief ack). */
  userReply: string;
  investigateScope?: CommandInvestigateScope;
  workloadHint?: string;
  namespace?: string;
  label?: string;
  getResource?: string;
  githubRepo?: string;
  gitRef?: string;
  deployStrategy?: 'gitops' | 'direct';
  /** Full OCI image ref when user wants a container image change (e.g. ghcr.io/org/app:tag). */
  containerImage?: string;
  /** Normalized fix hint for orchestrator, e.g. "set image to ghcr.io/org/app:tag". */
  operatorSuggestion?: string;
}

const INTENT_NAMES = new Set<CommandIntentName>([
  'investigate',
  'deploy',
  'rollback',
  'delete',
  'get',
  'ci-failure',
  'workload-status',
  'help',
  'chat',
]);

/** Parse and normalize LLM JSON into CommandIntent. */
export function parseCommandIntentJson(raw: string): CommandIntent | null {
  try {
    const parsed = JSON.parse(raw.trim()) as Partial<CommandIntent>;
    if (!parsed.intent || !INTENT_NAMES.has(parsed.intent as CommandIntentName)) {
      return null;
    }
    const confidence =
      typeof parsed.confidence === 'number'
        ? Math.min(1, Math.max(0, parsed.confidence))
        : 0.7;
    return {
      intent: parsed.intent as CommandIntentName,
      confidence,
      userReply: typeof parsed.userReply === 'string' ? parsed.userReply.trim() : '',
      investigateScope: parsed.investigateScope,
      workloadHint: parsed.workloadHint,
      namespace: parsed.namespace,
      label: parsed.label,
      getResource: parsed.getResource,
      githubRepo: parsed.githubRepo,
      gitRef: parsed.gitRef,
      deployStrategy: parsed.deployStrategy,
      containerImage:
        typeof parsed.containerImage === 'string' ? parsed.containerImage.trim() : undefined,
      operatorSuggestion:
        typeof parsed.operatorSuggestion === 'string' ? parsed.operatorSuggestion.trim() : undefined,
    };
  } catch {
    return null;
  }
}

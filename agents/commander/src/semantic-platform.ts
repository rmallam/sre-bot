/**
 * Commander integration — semantic-router gateway (Python platform-agent).
 */

import type { Platform } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import { platformRouteMessage, platformRoutingEnabled } from '../../../shared/src/platform-client.js';
import { parseCommand } from './parser.js';
import type { ParsedCommand } from './parser.js';
import type { LlmRouteResult } from './llm-router.js';

const AGENT = 'commander-platform-router';

const CHITCHAT_REPLY =
  'Hello — I can investigate Kubernetes issues, run remediations, or deploy apps. ' +
  'Try: *investigate CrashLoopBackOff in my-namespace/my-deployment*.';

function withReply(
  parsed: ParsedCommand,
  confidence: number,
  userReply?: string
): LlmRouteResult {
  return {
    parsed,
    confidence,
    userReply,
    conversationalReply: userReply,
  };
}

/**
 * Call Python semantic-router before regex/LLM routing when enabled.
 * Returns null to fall through to existing commander routing.
 */
export async function tryPlatformSemanticRoute(
  text: string,
  platform: Platform,
  userId: string
): Promise<LlmRouteResult | null> {
  if (!platformRoutingEnabled()) return null;

  const incidentId = `chat-${platform}-${userId}`;
  const route = await platformRouteMessage(text, incidentId);
  if (!route) return null;

  log('info', AGENT, 'Platform semantic route', {
    intent: route.intent,
    score: route.similarityScore,
    fallback: route.usedFallback,
  });

  if (route.intent === 'chitchat') {
    return withReply({ type: 'unknown' }, route.similarityScore, CHITCHAT_REPLY);
  }

  const parsed = parseCommand(text);

  if (route.intent === 'diagnose') {
    if (parsed.type === 'investigate' || parsed.type === 'workload-status') {
      return withReply(
        parsed,
        Math.max(route.similarityScore, 0.85),
        parsed.type === 'investigate'
          ? `Investigating ${parsed.label}…`
          : `Checking ${parsed.label}…`
      );
    }
    // Encourage investigate path even if regex missed namespace
    if (parsed.type !== 'unknown') {
      return withReply(parsed, route.similarityScore);
    }
    return withReply(
      { type: 'unknown' },
      route.similarityScore,
      'I can investigate that — which namespace and workload should I check?'
    );
  }

  if (route.intent === 'remediate') {
    if (parsed.type === 'investigate' || parsed.type === 'deploy' || parsed.type === 'rollback') {
      return withReply(
        parsed,
        Math.max(route.similarityScore, 0.88),
        parsed.type === 'deploy'
          ? `Starting remediation deploy for ${parsed.label}.`
          : `Applying remediation for ${parsed.label}…`
      );
    }
    return withReply(
      { type: 'unknown' },
      route.similarityScore,
      'Tell me the namespace and deployment to remediate, e.g. *restart deployment/api in prod*.'
    );
  }

  // default intent — fall through to hybrid/LLM router
  return null;
}

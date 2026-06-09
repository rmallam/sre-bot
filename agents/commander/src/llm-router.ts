/**
 * UX-3 — LLM-first routing with regex fast path and regex fallback on LLM outage.
 * UX-12–17 — help, transcript context, clarification, workload-status intent.
 */

import type { CommandIntent, CommandIntentName } from '../../../shared/src/command-intent.js';
import { parseCommandIntentJson } from '../../../shared/src/command-intent.js';
import type { Platform } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import { resolveCommanderLlm } from '../../../shared/src/llm-config.js';
import { openRouterChat, stripJsonFences } from '../../../shared/src/openrouter.js';
import {
  parseCommand,
  deployParseHint,
  investigateNeedsLlmResolution,
  parseRegexFastPath,
  type ParsedCommand,
} from './parser.js';
import { commandIntentToParsed, helpIntentReply } from './intent-mapper.js';
import { enrichInvestigateImageHint } from './investigate-image-enrich.js';
import { tryDeployBranchFollowUp, tryNamespaceCreateFollowUp, tryStatusFollowUp } from './conversation.js';
import { tryPrefFollowUp } from './channel-prefs.js';
import { trySessionFollowUp } from './session-followups.js';
import { tryResumeCaseWithHint } from './case-manager.js';
import { tryPlatformSemanticRoute } from './semantic-platform.js';
import { normalizeDeployCommand } from '../../../shared/src/deploy-command.js';
import type { DeployRoutingSource } from '../../../shared/src/deploy-confidence.js';
import { resolveAgentMode } from '../../../shared/src/agent-mode.js';
import { isHelpQuery, HELP_MESSAGE } from './help.js';
import { getChatTranscriptForLlm } from './chat-transcript.js';
import { classifySreTaskText } from '../../../shared/src/sre/sre-task-classifier.js';
import { trySreRagAdvisoryReply } from './sre-task-handler.js';
import { getSession } from './sessions.js';
import { setPendingClarification } from './clarification.js';

const SECURITY_URL = process.env['SECURITY_URL'] ?? 'http://security-agent:8080';
const GEMINI_API_KEY = process.env['GEMINI_API_KEY'];
const AGENT = 'commander-llm-router';

const CHAT_FALLBACK =
  "I'm your SRE assistant — ask me to deploy, investigate, list pods, or triage CI failures.";
const OFFLINE_HELP = HELP_MESSAGE;

export interface LlmRouteResult {
  parsed: ParsedCommand;
  conversationalReply?: string;
  userReply?: string;
  confidence: number;
  intent?: CommandIntentName;
  routingSource?: DeployRoutingSource;
  /** Raw githubRepo from LLM JSON before commander normalization. */
  llmRawGithubRepo?: string;
}

function commanderLlmAvailable(): boolean {
  try {
    resolveCommanderLlm();
    return true;
  } catch {
    return false;
  }
}

function withReply(
  parsed: ParsedCommand,
  confidence: number,
  opts?: {
    userReply?: string;
    intent?: CommandIntentName;
    routingSource?: DeployRoutingSource;
    llmRawGithubRepo?: string;
  }
): LlmRouteResult {
  const reply = opts?.userReply?.trim();
  return {
    parsed,
    confidence,
    intent: opts?.intent,
    routingSource: opts?.routingSource,
    llmRawGithubRepo: opts?.llmRawGithubRepo,
    conversationalReply: reply || undefined,
    userReply: reply || undefined,
  };
}

const HYBRID_GATE_MODE = (process.env['COMMANDER_HYBRID_GATE_MODE'] ?? 'balanced').toLowerCase();

function shouldBypassFastPath(text: string, parsed: ParsedCommand, llmAvailable: boolean): boolean {
  if (!llmAvailable) return false;
  if (HYBRID_GATE_MODE === 'off') return false;
  if (/^\s*\//.test(text) || /\bkubectl\b/i.test(text)) return false;

  const hasScopeAmbiguity = /\b(any|all|every|across|either|whichever)\b/i.test(text);
  const hasReferenceAmbiguity = /\b(this|that|it|those|these|same\s+one)\b/i.test(text);
  const asksSelection = /\bwhich\s+one\b/i.test(text);
  const statusWords = /\b(running|up|healthy|ready|status|health)\b/i.test(text);
  const investigateWords = /\b(investigate|diagnose|debug|check|look\s+at|inspect|wrong)\b/i.test(text);
  const scopeWords = /\b(namespace|namespaces|cluster)\b/i.test(text);

  if (HYBRID_GATE_MODE === 'strict') {
    if (parsed.type === 'workload-status') return true;
    if (parsed.type === 'investigate') return true;
  }

  if (parsed.type === 'workload-status') {
    return (
      (hasScopeAmbiguity && (scopeWords || statusWords)) ||
      (hasReferenceAmbiguity && statusWords) ||
      asksSelection
    );
  }

  if (parsed.type === 'investigate') {
    return (
      hasScopeAmbiguity ||
      hasReferenceAmbiguity ||
      asksSelection ||
      (scopeWords && investigateWords)
    );
  }

  if (parsed.type === 'get') {
    return (
      (hasScopeAmbiguity && scopeWords) ||
      (hasReferenceAmbiguity && /\b(get|list|show|display)\b/i.test(text))
    );
  }

  return false;
}

async function maybeSetClarification(
  platform: Platform,
  channelId: string,
  userId: string,
  parsed: ParsedCommand,
  userReply: string
): Promise<void> {
  if (parsed.type === 'investigate' && investigateNeedsLlmResolution(parsed)) {
    await setPendingClarification(platform, channelId, userId, {
      kind: 'investigate',
      awaiting: 'workload',
      namespace: parsed.namespace !== '_all' ? parsed.namespace : undefined,
      prompt: userReply,
      askedAt: new Date().toISOString(),
    });
    return;
  }
  if (
    parsed.type === 'workload-status' &&
    parsed.resourceName &&
    !parsed.namespace
  ) {
    await setPendingClarification(platform, channelId, userId, {
      kind: 'workload-status',
      awaiting: 'namespace',
      resourceName: parsed.resourceName,
      resourceKind: parsed.resourceKind,
      prompt: userReply,
      askedAt: new Date().toISOString(),
    });
  }
}

export async function routeMessage(
  text: string,
  platform: Platform,
  userId: string,
  channelId?: string
): Promise<LlmRouteResult> {
  try {
    const res = await fetch(`${SECURITY_URL}/sanitize-for-llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, incidentId: `chat-${userId}` }),
    });
    if (res.ok) {
      const data = (await res.json()) as { sanitizedText?: string; blocked?: boolean };
      if (data.blocked) {
        return withReply(
          { type: 'unknown' },
          1,
          { userReply: 'I cannot process that message due to security policy.' }
        );
      }
      if (data.sanitizedText) text = data.sanitizedText;
    }
  } catch (err) {
    log('warn', AGENT, 'Sanitize failed, continuing routing', { error: String(err) });
  }

  if (isHelpQuery(text)) {
    return withReply({ type: 'unknown' }, 1, { intent: 'help', userReply: HELP_MESSAGE });
  }

  const platformRoute = await tryPlatformSemanticRoute(text, platform, userId);
  if (platformRoute) {
    return platformRoute;
  }

  if (channelId) {
    const caseResume = await tryResumeCaseWithHint(text, platform, channelId, userId);
    if (caseResume) {
      return withReply(caseResume.parsed, 0.93, {
        userReply: caseResume.reply,
        routingSource: 'followup',
      });
    }

    const routingMode = resolveAgentMode().routingMode;

    if (routingMode !== 'llm_only') {
      const prefReply = tryPrefFollowUp(platform, channelId, text);
      if (prefReply) {
        return withReply({ type: 'unknown' }, 1, { userReply: prefReply });
      }
    }

    const sessionFollow = await trySessionFollowUp(text, platform, channelId, userId);
    if (sessionFollow?.type === 'reply') {
      return withReply({ type: 'unknown' }, 0.95, { userReply: sessionFollow.text });
    }
    if (sessionFollow?.type === 'parsed') {
      return withReply(sessionFollow.parsed, 0.92, {
        userReply: sessionFollow.reply,
        routingSource: 'followup',
      });
    }

    if (routingMode !== 'llm_only') {
      const nsDeploy = await tryNamespaceCreateFollowUp(platform, channelId, userId, text);
      if (nsDeploy) {
        return withReply(nsDeploy, 0.95, {
          userReply: `Got it — I'll create namespace \`${nsDeploy.namespace}\` and continue the deploy.`,
          routingSource: 'followup',
        });
      }
      const branchDeploy = await tryDeployBranchFollowUp(platform, channelId, userId, text);
      if (branchDeploy) {
        return withReply(branchDeploy, 0.95, {
          userReply: `Got it — retrying deploy on branch \`${branchDeploy.gitRef}\`.`,
          routingSource: 'followup',
        });
      }
      const statusReply = await tryStatusFollowUp(platform, channelId, userId, text);
      if (statusReply) {
        return withReply({ type: 'unknown' }, 0.9, { userReply: statusReply });
      }
    }
  }

  const llmAvailable = commanderLlmAvailable();
  const routingMode = resolveAgentMode().routingMode;
  const fast = routingMode === 'llm_only' && !/^\s*\//.test(text) ? null : parseRegexFastPath(text);
  if (fast && !shouldBypassFastPath(text, fast, llmAvailable)) {
    const transcript = channelId ? await getChatTranscriptForLlm(platform, channelId, userId) : [];
    const enriched =
      fast.type === 'investigate' && llmAvailable
        ? await enrichInvestigateImageHint(fast, text, userId, { transcript })
        : fast;
    return withReply(enriched, 0.95, { routingSource: 'regex' });
  }

  const session = channelId ? await getSession(platform, channelId, userId) : undefined;
  const transcript = channelId ? await getChatTranscriptForLlm(platform, channelId, userId) : [];

  if (llmAvailable) {
    const intent = await classifyIntentUnified(text, userId, {
      transcript,
      activeTopic: session?.activeTopic,
    });
    if (intent) {
      if (intent.intent === 'help') {
        return withReply({ type: 'unknown' }, intent.confidence, {
          intent: 'help',
          userReply: intent.userReply || helpIntentReply(),
        });
      }

      if (intent.intent === 'chat') {
        return withReply(
          { type: 'unknown' },
          intent.confidence,
          {
            intent: 'chat',
            userReply: intent.userReply || CHAT_FALLBACK,
          }
        );
      }

      const parsed = commandIntentToParsed(intent, text);
      if (parsed) {
        let enriched: ParsedCommand =
          parsed.type === 'investigate'
            ? await enrichInvestigateImageHint(parsed, text, userId, { transcript })
            : parsed;
        if (enriched.type === 'deploy') {
          enriched = normalizeDeployCommand(enriched);
        }
        const deployReady =
          enriched.type === 'deploy' &&
          !!(enriched.containerImage || enriched.githubRepo || enriched.stackServices?.length);
        const llmAsksMore =
          !!intent.userReply &&
          (/\?/.test(intent.userReply) ||
            /\b(catalog|github|repository|repo url|which repo)\b/i.test(intent.userReply));
        const ack =
          deployReady && llmAsksMore
            ? `Starting deploy of ${enriched.appName ?? enriched.githubRepo?.replace(/^github\.com\//, '') ?? 'app'} to namespace \`${enriched.namespace}\`…`
            : intent.userReply ||
              (enriched.type === 'deploy'
                ? `Starting deploy for ${enriched.githubRepo || enriched.appName || 'your app'}.`
                : enriched.type === 'investigate'
                  ? `Investigating ${enriched.label}…`
                  : enriched.type === 'workload-status'
                    ? `Checking ${enriched.label}…`
                    : enriched.type === 'ci-failure'
                      ? `Triaging CI for ${enriched.githubRepo.replace(/^github\.com\//, '')}…`
                      : undefined);
        return withReply(enriched, intent.confidence, {
          intent: intent.intent,
          userReply: ack,
          routingSource: 'llm',
          llmRawGithubRepo: intent.intent === 'deploy' ? intent.githubRepo : undefined,
        });
      }

      if (intent.intent === 'deploy') {
        const hint = deployParseHint(text);
        return withReply(
          { type: 'unknown' },
          intent.confidence,
          {
            intent: 'deploy',
            userReply: intent.userReply || hint || CHAT_FALLBACK,
          }
        );
      }

      const clarifyReply =
        intent.userReply ||
        "I understood the request but need a bit more detail (repo URL, namespace, or app name).";
      if (channelId && intent.intent === 'workload-status' && intent.workloadHint) {
        await setPendingClarification(platform, channelId, userId, {
          kind: 'workload-status',
          awaiting: 'namespace',
          resourceName: intent.workloadHint,
          prompt: clarifyReply,
          askedAt: new Date().toISOString(),
        });
      }

      return withReply(
        { type: 'unknown' },
        intent.confidence,
        { intent: intent.intent, userReply: clarifyReply }
      );
    }
    log('warn', AGENT, 'Unified LLM intent failed — regex fallback', { userId });
  }

  const regexParsed = parseCommand(text);
  if (regexParsed.type !== 'unknown') {
    if (regexParsed.type === 'investigate' && investigateNeedsLlmResolution(regexParsed)) {
      const userReply =
        'Which deployment or namespace should I investigate? For example: investigate the nginx deployment in staging.';
      if (channelId) {
        await maybeSetClarification(platform, channelId, userId, regexParsed, userReply);
      }
      return withReply(regexParsed, 0.55, { userReply });
    }
    return withReply(regexParsed, llmAvailable ? 0.75 : 0.9, { routingSource: 'regex' });
  }

  const sreAdvisory = classifySreTaskText(text);
  if (sreAdvisory?.advisoryOnly) {
    const ragReply = await trySreRagAdvisoryReply({
      text,
      classification: sreAdvisory,
      incidentId: `chat-${platform}-${userId}`,
    });
    if (ragReply) {
      return withReply({ type: 'unknown' }, sreAdvisory.confidence, { userReply: ragReply });
    }
  }

  if (!llmAvailable) {
    const hint = deployParseHint(text);
    return withReply(
      { type: 'unknown' },
      0.3,
      { userReply: hint || OFFLINE_HELP }
    );
  }

  const hint = deployParseHint(text);
  return withReply(
    { type: 'unknown' },
    0.45,
    {
      userReply:
        hint ||
        "Tell me what to deploy, investigate, or check — plain language is fine.",
    }
  );
}

const UNIFIED_INTENT_SYSTEM = `You are the intent router for an SRE chatbot. Reply with ONLY valid JSON matching this schema:
{
  "intent": "investigate" | "deploy" | "rollback" | "delete" | "get" | "ci-failure" | "workload-status" | "help" | "chat",
  "confidence": 0.0 to 1.0,
  "userReply": "1-3 short sentences for the user (greeting, ack, or what you still need)",
  "investigateScope": "cluster" | "namespace" | "workload" | "app",
  "workloadHint": "deployment/app name or empty",
  "namespace": "kubernetes namespace or empty",
  "label": "short human phrase",
  "getResource": "namespaces|pods|deployments|nodes|services|events",
  "githubRepo": "github.com/org/repo if deploy/ci/rollback",
  "gitRef": "branch/tag if specified else empty",
  "deployStrategy": "gitops" | "direct",
  "containerImage": "full OCI ref (registry/org/repo:tag) when user specifies an image, else empty",
  "operatorSuggestion": "set image to <containerImage> when user wants an image fix, else empty"
}
Rules:
- Prior conversation turns and activeTopic (if provided) are context — resolve it/that/also/the same from them
- Plain language: "can you deploy X to staging", "what's wrong with nginx", "list all pods"
- deploy: githubRepo when user gives github.com/org/repo; else workloadHint for catalog apps (httpd, nginx, redis) + namespace
- delete/remove/uninstall → intent delete (never get)
- ci-failure when user asks about failed CI/workflows/builds; set githubRepo when known
- fix/change image on a deployment → investigate workload, not deploy
- Names ending in -system or -operator-system (e.g. frappe-operator-system) are Kubernetes **namespaces**, not deployment names — set namespace, derive workloadHint (e.g. frappe-operator)
- ghcr/ghcr.io image hints → investigate; set containerImage to the full expanded ref and operatorSuggestion "set image to …"
- Expand image shorthand using workloadHint: "vyogotech ghcr latest" + frappe-operator → ghcr.io/vyogotech/frappe-operator:latest
- Informal phrasing ("pull the newest tag from GHCR", "bump to v2.1") → still set containerImage when intent is clear
- investigate cluster health → investigateScope cluster
- "why isn't app X working" / app-level end-to-end → investigateScope app, workloadHint = app name
- "is app running" / "is X up in namespace Y" → intent workload-status (NOT investigate); set workloadHint + namespace
- "is app running in any/all namespaces" → workload-status; never use "any" as namespace name — leave namespace empty or use scope words
- intent help when user asks what you can do, capabilities, or how to use the bot
- intent get when user asks to list/show/display pods, nodes, deployments, namespaces, services, or events (set getResource + namespace when given)
- intent chat only for greetings/thanks/off-topic; set userReply helpfully
- direct deploy if no git push → deployStrategy direct
- confidence: high when fields are explicit, lower when guessing`;

interface ClassifyContext {
  transcript: Array<{ role: 'user' | 'assistant'; content: string }>;
  activeTopic?: import('./sessions.js').ActiveTopic;
}

async function classifyIntentUnified(
  text: string,
  userId: string,
  ctx: ClassifyContext
): Promise<CommandIntent | null> {
  try {
    const llm = resolveCommanderLlm();
    const contextBlock =
      ctx.activeTopic || ctx.transcript.length > 0
        ? `\n\nContext:\nactiveTopic: ${JSON.stringify(ctx.activeTopic ?? null)}\nrecentTurns: ${JSON.stringify(ctx.transcript.slice(-6))}`
        : '';

    let raw = '';

    if (llm.backend === 'openrouter') {
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: UNIFIED_INTENT_SYSTEM },
      ];
      for (const turn of ctx.transcript.slice(-8)) {
        messages.push({
          role: turn.role === 'user' ? 'user' : 'assistant',
          content: turn.content,
        });
      }
      messages.push({ role: 'user', content: text + contextBlock });

      raw = await openRouterChat({
        model: llm.model,
        messages,
        jsonMode: true,
        temperature: 0.1,
        callerAgent: AGENT,
        incidentId: `chat-${userId}`,
      });
    } else if (llm.backend === 'gemini' && GEMINI_API_KEY) {
      const parts: string[] = [UNIFIED_INTENT_SYSTEM];
      if (ctx.transcript.length > 0) {
        parts.push('\nRecent conversation:');
        for (const turn of ctx.transcript.slice(-8)) {
          parts.push(`${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`);
        }
      }
      if (ctx.activeTopic) {
        parts.push(`\nActive topic: ${JSON.stringify(ctx.activeTopic)}`);
      }
      parts.push(`\nUser: ${text}`);

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${llm.model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: parts.join('\n') }] }],
            generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
          }),
        }
      );
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    } else {
      return null;
    }

    return parseCommandIntentJson(stripJsonFences(raw));
  } catch (err) {
    log('warn', AGENT, 'Unified intent classification failed', { error: String(err) });
    return null;
  }
}

/**
 * LLM intent router — conversational PA: LLM-first when configured, regex fallback.
 */

import type { Platform } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import { resolveCommanderLlm } from '../../../shared/src/llm-config.js';
import { openRouterChat, stripJsonFences } from '../../../shared/src/openrouter.js';
import {
  parseCommand,
  parseSimpleDeploy,
  deployParseHint,
  extractGithubRepo,
  investigateNeedsLlmResolution,
  type ParsedCommand,
  type InvestigateCmd,
  type InvestigateScope,
  type DeployCmd,
  parseDelete,
} from './parser.js';
import { tryDeployBranchFollowUp, tryNamespaceCreateFollowUp, tryStatusFollowUp } from './conversation.js';

const SECURITY_URL = process.env['SECURITY_URL'] ?? 'http://security-agent:8080';
const GEMINI_API_KEY = process.env['GEMINI_API_KEY'];
const AGENT = 'commander-llm-router';

export interface LlmRouteResult {
  parsed: ParsedCommand;
  conversationalReply?: string;
  confidence: number;
}

interface LlmStructuredIntent {
  intent: 'investigate' | 'deploy' | 'rollback' | 'delete' | 'get' | 'chat';
  investigateScope?: InvestigateScope;
  workloadHint?: string;
  namespace?: string;
  label?: string;
  getResource?: string;
  githubRepo?: string;
  gitRef?: string;
  deployStrategy?: 'gitops' | 'direct';
}

function commanderLlmAvailable(): boolean {
  try {
    resolveCommanderLlm();
    return true;
  } catch {
    return false;
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
        return {
          parsed: { type: 'unknown' },
          conversationalReply: 'I cannot process that message due to security policy.',
          confidence: 1,
        };
      }
      if (data.sanitizedText) text = data.sanitizedText;
    }
  } catch (err) {
    log('warn', AGENT, 'Sanitize failed, using regex only', { error: String(err) });
  }

  if (channelId) {
    const nsDeploy = tryNamespaceCreateFollowUp(platform, channelId, userId, text);
    if (nsDeploy) {
      return {
        parsed: nsDeploy,
        conversationalReply: `Got it — I'll create namespace \`${nsDeploy.namespace}\` and continue the deploy.`,
        confidence: 0.95,
      };
    }
    const branchDeploy = tryDeployBranchFollowUp(platform, channelId, userId, text);
    if (branchDeploy) {
      return {
        parsed: branchDeploy,
        conversationalReply: `Got it — retrying deploy on branch \`${branchDeploy.gitRef}\`.`,
        confidence: 0.95,
      };
    }
    const statusReply = tryStatusFollowUp(platform, channelId, userId, text);
    if (statusReply) {
      return { parsed: { type: 'unknown' }, conversationalReply: statusReply, confidence: 0.9 };
    }
  }

  if (commanderLlmAvailable()) {
    const structured = await classifyIntentStructured(text, userId);
    if (structured) {
      if (structured.intent === 'chat') {
        // Guardrail: if regex parser can extract an operational command,
        // prefer action over generic chat fallback.
        const regexFallback = parseCommand(text);
        if (regexFallback.type !== 'unknown') {
          return { parsed: regexFallback, confidence: 0.82 };
        }
        const reply = await classifyWithLlm(text, userId);
        return {
          parsed: { type: 'unknown' },
          conversationalReply:
            reply.slice(0, 800) ||
            "I'm your SRE assistant — ask me to deploy, investigate, or check cluster resources.",
          confidence: 0.75,
        };
      }

      const fromStructured = structuredToCommand(structured, text);
      if (fromStructured) {
        return { parsed: fromStructured, confidence: 0.88 };
      }
      if (structured.intent === 'deploy') {
        const catalogDeploy = parseSimpleDeploy(text);
        if (catalogDeploy) {
          return { parsed: catalogDeploy, confidence: 0.86 };
        }
      }
    }
  }

  const regexParsed = parseCommand(text);

  if (regexParsed.type === 'investigate' && investigateNeedsLlmResolution(regexParsed)) {
    const resolved = await resolveInvestigateWithLlm(text, userId);
    if (resolved) {
      return { parsed: resolved, confidence: 0.85 };
    }
  }

  if (regexParsed.type !== 'unknown') {
    return { parsed: regexParsed, confidence: 0.9 };
  }

  if (!commanderLlmAvailable()) {
    return {
      parsed: regexParsed,
      conversationalReply:
        "I'm your SRE assistant. Try:\n• investigate my cluster health\n• investigate the frappe deployment\n• deploy github.com/org/repo to staging namespace",
      confidence: 0.3,
    };
  }

  const deployHint = deployParseHint(text);
  if (deployHint) {
    return { parsed: regexParsed, conversationalReply: deployHint, confidence: 0.55 };
  }

  const llmText = await classifyWithLlm(text, userId);
  return {
    parsed: regexParsed,
    conversationalReply:
      llmText.slice(0, 800) ||
      "Tell me what to deploy, investigate, or rollback — plain language is fine.",
    confidence: 0.5,
  };
}

function structuredToCommand(s: LlmStructuredIntent, text: string): ParsedCommand | null {
  if (s.intent === 'get') {
    const getParsed = parseCommand(text);
    if (getParsed.type === 'get') return getParsed;
    const rebuilt = parseCommand(
      `get ${s.getResource ?? 'pods'}${s.namespace ? ` in ${s.namespace}` : ''}`
    );
    if (rebuilt.type === 'get') return rebuilt;
    return null;
  }
  if (s.intent === 'investigate') {
    return structuredToInvestigate(s);
  }
  if (s.intent === 'deploy') {
    return structuredToDeploy(s, text);
  }
  if (s.intent === 'rollback') {
    const rb = parseCommand(text.includes('rollback') ? text : `rollback ${text}`);
    if (rb.type === 'rollback') return rb;
  }
  if (s.intent === 'delete') {
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
  }
  return null;
}

function structuredToDeploy(s: LlmStructuredIntent, text: string): DeployCmd | null {
  const catalogDeploy = parseSimpleDeploy(text);
  if (catalogDeploy) return catalogDeploy;

  const githubRepo = s.githubRepo ?? extractGithubRepo(text);
  if (!githubRepo) {
    if (s.workloadHint) {
      const hintDeploy = parseSimpleDeploy(
        text.toLowerCase().includes('deploy') ? text : `deploy ${s.workloadHint} in ${s.namespace ?? 'default'} namespace`
      );
      if (hintDeploy) return hintDeploy;
    }
    return null;
  }

  const regexDeploy = parseCommand(text.includes('deploy') ? text : `deploy ${text}`);
  const namespace =
    s.namespace ?? (regexDeploy.type === 'deploy' ? regexDeploy.namespace : 'default');
  const gitRef = s.gitRef ?? (regexDeploy.type === 'deploy' ? regexDeploy.gitRef : 'main');
  const directExplicit =
    s.deployStrategy === 'direct' ||
    (regexDeploy.type === 'deploy' && regexDeploy.deployStrategy === 'direct');

  return {
    type: 'deploy',
    githubRepo,
    gitRef,
    namespace,
    deployStrategy: directExplicit ? 'direct' : 'gitops',
    deployStrategyExplicit:
      !!s.deployStrategy ||
      (regexDeploy.type === 'deploy' && regexDeploy.deployStrategyExplicit),
  };
}

function structuredToInvestigate(s: LlmStructuredIntent): InvestigateCmd | null {
  const scope = s.investigateScope ?? (s.workloadHint ? 'workload' : 'cluster');
  if (scope === 'cluster') {
    return {
      type: 'investigate',
      scope: 'cluster',
      namespace: '_all',
      resourceName: '_cluster',
      label: s.label ?? 'cluster health',
    };
  }
  if (scope === 'namespace' && s.namespace) {
    return {
      type: 'investigate',
      scope: 'namespace',
      namespace: s.namespace,
      resourceName: '_namespace',
      label: s.label ?? `${s.namespace} namespace`,
    };
  }
  if (s.workloadHint) {
    return {
      type: 'investigate',
      scope: 'workload',
      namespace: s.namespace ?? 'default',
      resourceName: s.workloadHint,
      workloadHint: s.workloadHint,
      label: s.label ?? `${s.workloadHint} deployment`,
    };
  }
  return null;
}

async function resolveInvestigateWithLlm(text: string, userId: string): Promise<InvestigateCmd | null> {
  const structured = await classifyIntentStructured(text, userId);
  if (structured?.intent === 'investigate') {
    return structuredToInvestigate(structured);
  }
  return null;
}

async function classifyIntentStructured(text: string, userId: string): Promise<LlmStructuredIntent | null> {
  const system = `You classify SRE operator chat into structured intents. Reply with ONLY valid JSON:
{
  "intent": "investigate" | "deploy" | "rollback" | "delete" | "get" | "chat",
  "investigateScope": "cluster" | "namespace" | "workload",
  "workloadHint": "deployment/app name hint or empty",
  "namespace": "kubernetes namespace or empty",
  "label": "short human phrase",
  "getResource": "namespaces|pods|deployments|nodes|services|events",
  "githubRepo": "github.com/org/repo if deploy/rollback",
  "gitRef": "branch/tag if user specified, else empty",
  "deployStrategy": "gitops" | "direct"
}
Rules:
- Plain language is normal: "can you deploy X to staging", "what's wrong with nginx", "list all pods"
- deploy: extract githubRepo when user gives github.com/org/repo; otherwise workloadHint can be a catalog app (httpd, nginx, redis) with namespace
- "deploy httpd in simple namespace" → intent deploy, workloadHint httpd, namespace simple (no githubRepo)
- "delete httpd from default namespace" / "remove nginx in staging" → intent delete, workloadHint = app name, namespace set
- delete/remove/uninstall is never intent get (do not list pods when user wants to delete an app)
- Requests like "fix deployment X by changing image/tag" are investigate intent (workload), not deploy.
- investigate cluster health → investigateScope cluster
- workload hints must never be stop words (the, my, a, deployment)
- intent chat: greetings, thanks, general questions not about K8s ops
- direct deploy if user says no git push / apply directly → deployStrategy direct`;

  try {
    const llm = resolveCommanderLlm();
    if (llm.backend === 'openrouter') {
      const raw = await openRouterChat({
        model: llm.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text },
        ],
        jsonMode: true,
        temperature: 0.1,
        callerAgent: AGENT,
        incidentId: `chat-${userId}`,
      });
      return parseIntentJson(stripJsonFences(raw));
    }

    if (llm.backend === 'gemini' && GEMINI_API_KEY) {
      const model = llm.model;
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${system}\n\nUser: ${text}` }] }],
            generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
          }),
        }
      );
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      return parseIntentJson(stripJsonFences(raw));
    }
  } catch (err) {
    log('warn', AGENT, 'Structured intent classification failed', {
      error: String(err),
    });
  }
  return null;
}

function parseIntentJson(raw: string): LlmStructuredIntent | null {
  try {
    const parsed = JSON.parse(raw.trim()) as LlmStructuredIntent;
    if (!parsed.intent) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function classifyWithLlm(text: string, userId: string): Promise<string> {
  try {
    const llm = resolveCommanderLlm();
    const system =
      'You are a friendly SRE assistant in Telegram/Slack. Reply in 1-3 short sentences. ' +
      'You can deploy from GitHub repos, delete/remove apps from a namespace, investigate issues, list K8s resources, and roll back. ' +
      'If the user wants an action, tell them what you understood and what you need (repo URL, namespace, branch). ' +
      'Do not make up cluster state.';

    if (llm.backend === 'openrouter') {
      return await openRouterChat({
        model: llm.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text },
        ],
        temperature: 0.3,
        callerAgent: AGENT,
        incidentId: `chat-${userId}`,
      });
    }
    if (llm.backend === 'gemini' && GEMINI_API_KEY) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${llm.model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${system}\n\nUser: ${text}` }] }],
            generationConfig: { temperature: 0.3 },
          }),
        }
      );
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    }
  } catch (err) {
    log('warn', AGENT, 'classifyWithLlm failed', { error: String(err) });
  }
  return '';
}

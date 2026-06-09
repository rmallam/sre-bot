/**
 * LLM-first ReAct read-tool selection for agentic investigation.
 */

import type { DiagnosisContext } from '../../../shared/src/types.js';
import type { AgentReadToolCall, AgentReadToolName } from '../../../shared/src/agent-read-tools.js';
import { isAgentReadTool } from '../../../shared/src/agent-read-tools.js';
import { formatAgentToolCatalogForLlm } from '../../../shared/src/agent-tool-catalog.js';
import {
  buildAgentGoal,
  evidenceSummaryForLlm,
} from '../../../shared/src/agent-evidence.js';
import { resolveBrainLlm } from '../../../shared/src/llm-config.js';
import { openRouterChat, stripJsonFences } from '../../../shared/src/openrouter.js';
import { log } from '../../../shared/src/http.js';
import type { AgentNextReadRequest, AgentNextReadResponse } from './agent-loop.js';
import { heuristicAgentNextRead } from './agent-loop-heuristics.js';

const AGENT = 'brain-agent-next-read-llm';

export type AgentReadDecision =
  | 'call_tool'
  | 'enough_evidence'
  | 'ask_user'
  | 'escalate';

interface LlmNextReadPayload {
  decision: AgentReadDecision;
  tool?: string;
  toolInput?: Record<string, unknown>;
  summary: string;
  reasoning?: string;
  askUserPrompt?: string;
}

function parseLlmNextRead(raw: string): LlmNextReadPayload | null {
  try {
    const parsed = JSON.parse(stripJsonFences(raw)) as LlmNextReadPayload;
    if (!parsed.decision || !parsed.summary) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function callLlmNextRead(req: AgentNextReadRequest): Promise<LlmNextReadPayload> {
  const llm = resolveBrainLlm();
  const catalog = formatAgentToolCatalogForLlm();
  const evidenceBlock = evidenceSummaryForLlm(req.evidence);
  const prior = req.priorSteps
    .slice(-8)
    .map((s) => `- ${s.tool}: ${s.summary}`)
    .join('\n');
  const fetched = req.fetchedTools.length ? req.fetchedTools.join(', ') : 'none';
  const hints = req.userHints?.length ? req.userHints.join('; ') : 'none';

  const system = `You are an SRE investigation agent in a ReAct loop. Pick the NEXT read-only tool to gather evidence, or stop when you can plan a fix.

Available read tools (ONLY these names):
${catalog}

Rules:
- One tool per turn. Do not repeat tools already fetched unless evidence is stale.
- Order: get_workload → get_events first. Only call logs/metrics if container is running or crash-looping (not ImagePullBackOff/ErrImagePull).
- If container status or events show ImagePullBackOff, ErrImagePull, InvalidImageName, or CrashLoopBackOff, stop after workload+events — do NOT fetch logs/metrics for pull failures (containers never started).
- decision=enough_evidence when a terminal failure is identified OR you can recommend restart, git_patch, or escalate with confidence.
- decision=ask_user when ImagePullBackOff/ErrImagePull and user has not supplied image tag or pull secret.
- decision=escalate when unsafe to proceed or evidence is inconclusive after reasonable fetches.
- Never invent tool names. Never suggest writes — only read tools above.

Respond JSON only:
{
  "decision": "call_tool" | "enough_evidence" | "ask_user" | "escalate",
  "tool": "investigator.get_workload",
  "toolInput": {},
  "summary": "short user-facing progress line",
  "reasoning": "brief internal reasoning",
  "askUserPrompt": "only when decision=ask_user"
}`;

  const user = `Goal: ${req.goal}
Namespace: ${req.namespace}
Workload: ${req.resourceName}
User hints: ${hints}
Tools already fetched: ${fetched}
Prior steps:
${prior || 'none'}

Evidence so far:
${evidenceBlock}`;

  if (llm.backend === 'openrouter') {
    const raw = await openRouterChat({
      model: llm.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      jsonMode: true,
      callerAgent: AGENT,
      incidentId: req.incidentId,
    });
    const parsed = parseLlmNextRead(raw);
    if (!parsed) throw new Error('LLM returned invalid JSON for agent-next-read');
    return parsed;
  }

  const { GoogleGenAI } = await import('@google/genai');
  const apiKey = process.env['GEMINI_API_KEY'];
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const genai = new GoogleGenAI({ apiKey });
  const res = await genai.models.generateContent({
    model: llm.model,
    contents: [{ role: 'user', parts: [{ text: `${system}\n\n${user}` }] }],
    config: { responseMimeType: 'application/json', temperature: 0.1 },
  });
  const raw = res.text ?? '';
  const parsed = parseLlmNextRead(raw);
  if (!parsed) throw new Error('Gemini returned invalid JSON for agent-next-read');
  return parsed;
}

export async function agentNextReadLlm(req: AgentNextReadRequest): Promise<AgentNextReadResponse> {
  try {
    const llmOut = await callLlmNextRead(req);

    if (llmOut.decision === 'enough_evidence') {
      return { done: true, summary: llmOut.summary, reasoning: llmOut.reasoning ?? 'llm_enough' };
    }
    if (llmOut.decision === 'ask_user') {
      return {
        done: true,
        summary: llmOut.askUserPrompt ?? llmOut.summary,
        reasoning: 'llm_ask_user',
      };
    }
    if (llmOut.decision === 'escalate') {
      return {
        done: true,
        summary: llmOut.summary,
        reasoning: 'llm_escalate',
      };
    }

    const toolName = llmOut.tool?.trim() ?? '';
    if (!isAgentReadTool(toolName)) {
      log('warn', AGENT, 'LLM picked invalid tool, falling back to heuristics', { tool: toolName });
      return heuristicAgentNextRead(req);
    }
    if (req.fetchedTools.includes(toolName)) {
      return {
        done: true,
        summary: llmOut.summary || 'Already fetched available tools — ready to plan.',
        reasoning: 'llm_duplicate_tool',
      };
    }

    const toolCall: AgentReadToolCall = {
      name: toolName as AgentReadToolName,
      input: llmOut.toolInput,
    };
    return {
      done: false,
      toolCall,
      summary: llmOut.summary,
      reasoning: llmOut.reasoning ?? 'llm_call_tool',
    };
  } catch (err) {
    log('warn', AGENT, 'LLM next-read failed, heuristic fallback', {
      error: String(err),
      incidentId: req.incidentId,
    });
    return heuristicAgentNextRead(req);
  }
}

export async function agentReflectLlm(req: {
  incidentId: string;
  verifyStatus: 'healthy' | 'degraded' | 'unknown';
  verifyMessage?: string;
  actionHistory: import('../../../shared/src/types.js').ActionRecord[];
  iteration: number;
  maxIterations: number;
  evidence?: Partial<DiagnosisContext>;
  goal?: string;
}): Promise<{
  outcome: 'succeeded' | 'retry' | 'escalate' | 'ask_user';
  operatorMessage: string;
  focusGoal?: string;
}> {
  if (req.verifyStatus === 'healthy') {
    return { outcome: 'succeeded', operatorMessage: 'Workload recovered after remediation.' };
  }
  if (req.iteration >= req.maxIterations) {
    return {
      outcome: 'escalate',
      operatorMessage: req.verifyMessage ?? 'Remediation did not restore health within allowed attempts.',
    };
  }

  try {
    const llm = resolveBrainLlm();
    const lastFail = [...req.actionHistory].reverse().find((a) => !a.success);
    const system = `You are an SRE agent reflecting after a failed verify step. Respond JSON only:
{ "outcome": "retry" | "escalate" | "ask_user", "operatorMessage": "...", "focusGoal": "optional retry focus" }
Prefer retry if another read-only investigation pass may help. Escalate if repeated failures or unsafe.`;

    const user = `Verify: ${req.verifyStatus}
Message: ${req.verifyMessage ?? 'none'}
Last action: ${lastFail?.summary ?? 'unknown'}
Iteration ${req.iteration}/${req.maxIterations}
Goal: ${req.goal ?? 'restore workload health'}
Evidence: ${req.evidence ? evidenceSummaryForLlm(req.evidence).slice(0, 1200) : 'none'}`;

    let raw: string;
    if (llm.backend === 'openrouter') {
      raw = await openRouterChat({
        model: llm.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        jsonMode: true,
        callerAgent: 'brain-agent-reflect',
        incidentId: req.incidentId,
      });
    } else {
      const { GoogleGenAI } = await import('@google/genai');
      const apiKey = process.env['GEMINI_API_KEY'];
      if (!apiKey) throw new Error('GEMINI_API_KEY not set');
      const genai = new GoogleGenAI({ apiKey });
      const res = await genai.models.generateContent({
        model: llm.model,
        contents: [{ role: 'user', parts: [{ text: `${system}\n\n${user}` }] }],
        config: { responseMimeType: 'application/json', temperature: 0.1 },
      });
      raw = res.text ?? '';
    }

    const parsed = JSON.parse(stripJsonFences(raw)) as {
      outcome?: string;
      operatorMessage?: string;
      focusGoal?: string;
    };
    const outcome = parsed.outcome;
    if (outcome === 'retry' || outcome === 'escalate' || outcome === 'ask_user') {
      return {
        outcome,
        operatorMessage: parsed.operatorMessage ?? 'Continuing investigation…',
        focusGoal: parsed.focusGoal,
      };
    }
  } catch (err) {
    log('warn', 'brain-agent-reflect', 'LLM reflect fallback', { error: String(err) });
  }

  const lastFail = [...req.actionHistory].reverse().find((a) => !a.success);
  return {
    outcome: 'retry',
    operatorMessage: lastFail?.summary ?? req.verifyMessage ?? 'Verify failed — gathering more evidence.',
    focusGoal: 'verify_failed_retry',
  };
}

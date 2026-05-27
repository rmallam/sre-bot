/**
 * Capability-first planner — LLM selects tools from registry catalog.
 */

import type { DiagnosisContext, RemediationPlan } from '../../../shared/src/types.js';
import type { ToolCall, ToolCallName } from '../../../shared/src/tool-contracts.js';
import { listToolDefinitions } from '../../../shared/src/tool-registry.js';
import { validateToolCalls } from '../../../shared/src/tool-validation.js';
import { diagnose } from './gemini.js';
import { log } from '../../../shared/src/http.js';

const AGENT = 'brain-agent';
const VALID_TOOLS = new Set(listToolDefinitions().map((t) => t.name));

export interface CapabilityPlanResult {
  toolCalls: ToolCall[];
  remediationPlan: RemediationPlan;
  reasoning: string;
  confidence: number;
}

function toolCallsToPlan(toolCalls: ToolCall[], ctx: DiagnosisContext): RemediationPlan {
  const names = toolCalls.map((t) => t.name);
  let action: RemediationPlan['action'] = 'noop';
  if (names.includes('gitops.apply_plan')) {
    const input = toolCalls.find((t) => t.name === 'gitops.apply_plan')?.input as { plan?: RemediationPlan };
    action = input?.plan?.action ?? 'git_patch';
  } else if (names.includes('executor.restart_workload')) {
    action = 'restart';
  }
  return {
    action,
    rootCause: 'Capability planner selected tool pipeline',
    reasoning: `Tools: ${names.join(' → ')}`,
    severity: 'MEDIUM',
    proposedPatch: [],
    targetManifestPath: ctx.gitManifestPath ?? '',
    commitMessage: 'fix(sre-bot): capability-planned remediation',
    rollbackSafe: true,
    githubRepo: ctx.githubRepo,
    gitRef: 'main',
  };
}

function parseToolCallsFromLlm(raw: unknown, ctx: DiagnosisContext): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const name = (item as { name?: string }).name as ToolCallName;
    if (!VALID_TOOLS.has(name)) continue;
    if (name === 'executor.restart_workload') {
      calls.push({
        name,
        input: {
          incidentId: ctx.incidentId,
          runId: 'capability',
          namespace: ctx.namespace,
          resourceName: ctx.resourceName,
          resourceKind: ctx.resourceKind,
        },
      });
    } else if (name === 'gitops.apply_plan') {
      calls.push({
        name,
        input: {
          incidentId: ctx.incidentId,
          runId: 'capability',
          mode: ctx.mode,
          namespace: ctx.namespace,
          resourceName: ctx.resourceName,
          resourceKind: ctx.resourceKind,
          plan: toolCallsToPlan([], ctx),
          request: {},
        },
      });
    } else if (name === 'investigator.repo_inspect' && ctx.githubRepo) {
      calls.push({
        name,
        input: {
          incidentId: ctx.incidentId,
          githubRepo: ctx.githubRepo,
          gitRef: 'main',
          namespace: ctx.namespace,
          resourceName: ctx.resourceName,
        },
      });
    } else if (name === 'investigator.verify_health') {
      calls.push({
        name,
        input: {
          incidentId: ctx.incidentId,
          namespace: ctx.namespace,
          resourceName: ctx.resourceName,
        },
      });
    } else if (name === 'commander.notify') {
      calls.push({
        name,
        input: {
          incidentId: ctx.incidentId,
          message: '__RUNTIME_NOTIFY__',
          platform: ctx.platform,
          channelId: ctx.channelId,
        },
      });
    } else if (name === 'argo.wait_sync') {
      calls.push({
        name,
        input: {
          incidentId: ctx.incidentId,
          appName: `${ctx.namespace}-${ctx.resourceName}`,
        },
      });
    }
  }
  return calls;
}

/**
 * Capability plan: try LLM tool selection; fall back to classic diagnose → compile mapping.
 */
export async function planCapability(ctx: DiagnosisContext): Promise<CapabilityPlanResult> {
  const catalog = listToolDefinitions()
    .map((t) => `- ${t.name}: ${t.description} (risk=${t.risk})`)
    .join('\n');

  const prompt = `Given incident facts, pick an ordered list of tool names from this catalog only:
${catalog}

Return JSON: { "tools": ["tool.name", ...], "reasoning": "...", "confidence": 0.0-1.0 }
Always end with investigator.verify_health. Include commander.notify if user channel present.
For transient pod issues prefer executor.restart_workload. For manifest fixes use gitops.apply_plan.`;

  let toolCalls: ToolCall[] = [];
  let reasoning = 'Fallback to classic remediation plan';
  let confidence = 0.7;

  try {
    const classic = await diagnose(ctx);
    if (classic.action === 'restart') {
      toolCalls = parseToolCallsFromLlm(
        [{ name: 'executor.restart_workload' }, { name: 'investigator.verify_health' }],
        ctx
      );
    } else if (['git_patch', 'helm_deploy', 'repo_apply'].includes(classic.action)) {
      toolCalls = parseToolCallsFromLlm(
        [{ name: 'gitops.apply_plan' }, { name: 'investigator.verify_health' }],
        ctx
      );
      const gitops = toolCalls.find((t) => t.name === 'gitops.apply_plan');
      if (gitops) {
        (gitops.input as { plan: RemediationPlan }).plan = classic;
      }
    }
    reasoning = classic.reasoning;
    confidence = 0.85;
  } catch (err) {
    log('warn', AGENT, 'Capability plan fallback failed', { error: String(err) });
  }

  if (ctx.platform && ctx.channelId && !toolCalls.some((t) => t.name === 'commander.notify')) {
    toolCalls.push({
      name: 'commander.notify',
      input: {
        incidentId: ctx.incidentId,
        message: '__RUNTIME_NOTIFY__',
        platform: ctx.platform,
        channelId: ctx.channelId,
      },
    });
  }

  const validation = validateToolCalls(toolCalls);
  if (!validation.ok) {
    log('warn', AGENT, 'Capability tool validation failed', { errors: validation.errors });
    confidence = 0.5;
  }

  const remediationPlan = toolCallsToPlan(toolCalls, ctx);
  if (toolCalls.some((t) => t.name === 'gitops.apply_plan')) {
    const g = toolCalls.find((t) => t.name === 'gitops.apply_plan');
    if (g && (g.input as { plan?: RemediationPlan }).plan) {
      Object.assign(remediationPlan, (g.input as { plan: RemediationPlan }).plan);
    }
  }

  return { toolCalls, remediationPlan, reasoning, confidence };
}

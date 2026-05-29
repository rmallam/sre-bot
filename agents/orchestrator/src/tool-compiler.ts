import type { ToolCall, RuntimeToolContext } from '../../../shared/src/tool-contracts.js';
import type { CompiledPlan } from '../../../shared/src/tool-registry.js';
import { aggregateToolRisk } from '../../../shared/src/tool-registry.js';
import { validateToolCalls } from '../../../shared/src/tool-validation.js';

function coreActionCalls(ctx: RuntimeToolContext): ToolCall[] {
  const action = ctx.plan.action;

  if (action === 'restart') {
    return [
      {
        name: 'executor.restart_workload',
        input: {
          incidentId: ctx.incidentId,
          runId: ctx.runId,
          namespace: ctx.namespace,
          resourceName: ctx.resourceName,
          resourceKind: ctx.resourceKind,
        },
      },
    ];
  }

  if (action === 'git_patch' || action === 'helm_deploy' || action === 'repo_apply') {
    return [
      {
        name: 'gitops.apply_plan',
        input: {
          incidentId: ctx.incidentId,
          runId: ctx.runId,
          mode: ctx.mode,
          namespace: ctx.namespace,
          resourceName: ctx.resourceName,
          resourceKind: ctx.resourceKind,
          plan: ctx.plan,
          request: ctx.request,
        },
      },
    ];
  }

  return [];
}

function appendStandardPipeline(ctx: RuntimeToolContext, calls: ToolCall[]): ToolCall[] {
  if (calls.length === 0) return calls;

  const pipeline: ToolCall[] = [...calls];
  // Health/readiness verification is handled centrally by graph verifyNode.
  // Running verify inside the compiled action pipeline can cause false "act failed"
  // loops when apply already succeeded but readiness is still converging.

  // Pre-deploy: gitops sends step-by-step progress; skip noisy per-tool notify here.
  if (ctx.request.platform && ctx.request.channelId && ctx.mode !== 'pre-deploy') {
    pipeline.push({
      name: 'commander.notify',
      input: {
        incidentId: ctx.incidentId,
        runId: ctx.runId,
        platform: ctx.request.platform,
        channelId: ctx.request.channelId,
        message: '__RUNTIME_NOTIFY__',
      },
    });
  }

  return pipeline;
}

/**
 * Multi-step compile: optional inspect → act → verify → notify.
 */
export function compilePlanToToolCalls(ctx: RuntimeToolContext): ToolCall[] {
  const calls: ToolCall[] = [];

  if (
    ctx.mode === 'pre-deploy' &&
    ctx.request.githubRepo &&
    ctx.plan.action !== 'noop' &&
    ctx.plan.action !== 'escalate_human'
  ) {
    calls.push({
      name: 'investigator.repo_inspect',
      input: {
        incidentId: ctx.incidentId,
        githubRepo: ctx.request.githubRepo,
        gitRef: ctx.request.gitRef ?? 'main',
        namespace: ctx.namespace,
        resourceName: ctx.resourceName,
      },
    });
  }

  if (ctx.plan.action === 'escalate_human') {
    if (ctx.request.platform && ctx.request.channelId) {
      calls.push({
        name: 'commander.notify',
        input: {
          incidentId: ctx.incidentId,
          runId: ctx.runId,
          platform: ctx.request.platform,
          channelId: ctx.request.channelId,
          message: `🙋 Human review needed: ${ctx.plan.reasoning}`,
        },
      });
    }
    return calls;
  }

  calls.push(...coreActionCalls(ctx));
  return appendStandardPipeline(ctx, calls);
}

function estimateConfidence(ctx: RuntimeToolContext, calls: ToolCall[]): number {
  const action = ctx.plan.action;
  if (calls.length === 0) return 0.4;

  if (action === 'restart') return 0.95;
  if (action === 'repo_apply') return 0.78;
  if (action === 'helm_deploy') {
    const hasGenerated = !!ctx.plan.helmChart?.files && Object.keys(ctx.plan.helmChart.files).length > 0;
    return hasGenerated ? 0.9 : 0.82;
  }
  if (action === 'git_patch') {
    return ctx.plan.proposedPatch.length > 0 ? 0.85 : 0.55;
  }
  return 0.6;
}

function fallbackReason(ctx: RuntimeToolContext, calls: ToolCall[]): string | undefined {
  if (calls.length === 0) {
    if (ctx.plan.action === 'escalate_human') return 'Plan escalated to human';
    if (ctx.plan.action === 'noop') return 'No operation required';
    return 'No executable tool mapping for plan action';
  }
  if (ctx.plan.action === 'git_patch' && ctx.plan.proposedPatch.length === 0) {
    return 'git_patch plan has empty proposedPatch';
  }
  return undefined;
}

export function compileFromToolCalls(calls: ToolCall[], ctx: RuntimeToolContext): CompiledPlan {
  const allowEmpty = ctx.plan.action === 'escalate_human' || ctx.plan.action === 'noop';
  const validation = validateToolCalls(calls, { allowEmpty });
  const confidence = validation.ok ? estimateConfidence(ctx, calls) : 0.4;
  const riskLevel = aggregateToolRisk(calls);

  return {
    calls,
    confidence,
    riskLevel,
    validation,
    fallbackReason: calls.length === 0 ? 'No tool calls in capability plan' : fallbackReason(ctx, calls),
  };
}

export function compileAndValidatePlan(ctx: RuntimeToolContext): CompiledPlan {
  return compileFromToolCalls(compilePlanToToolCalls(ctx), ctx);
}

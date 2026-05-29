/**
 * Turn operator natural-language fix suggestions into RemediationPlan JSON.
 */

import type { ApprovalRequest, RemediationPlan } from '../../../shared/src/types.js';
import { tryParseOperatorSuggestion } from '../../../shared/src/suggest-fix-parse.js';
import { log } from '../../../shared/src/http.js';
import { diagnose } from './gemini.js';
import type { DiagnosisContext } from '../../../shared/src/types.js';

const AGENT = 'brain-agent';

export interface SuggestPlanRequest {
  suggestion: string;
  approval: Pick<
    ApprovalRequest,
    'incidentId' | 'namespace' | 'resourceKind' | 'resourceName' | 'mode' | 'plan'
  >;
  /** Optional sanitized facts from investigator (improves LLM plans). */
  facts?: Partial<DiagnosisContext>;
}

export interface SuggestPlanResponse {
  plan: RemediationPlan;
  source: 'rules' | 'llm';
  summary: string;
}

export async function planFromSuggestion(req: SuggestPlanRequest): Promise<SuggestPlanResponse> {
  const { suggestion, approval } = req;
  const basePlan = approval.plan;

  const rulePlan = tryParseOperatorSuggestion(suggestion, {
    namespace: approval.namespace,
    resourceKind: approval.resourceKind,
    resourceName: approval.resourceName,
    basePlan,
  });

  if (rulePlan) {
    return {
      plan: rulePlan,
      source: 'rules',
      summary: formatPlanSummary(rulePlan),
    };
  }

  const ctx: DiagnosisContext = {
    incidentId: approval.incidentId,
    triggeredBy: 'commander',
    triggeredAt: new Date().toISOString(),
    namespace: approval.namespace,
    resourceKind: approval.resourceKind,
    resourceName: approval.resourceName,
    mode: approval.mode,
    podSpec: req.facts?.podSpec ?? {},
    containerStatuses: req.facts?.containerStatuses ?? [],
    resourceLimits: req.facts?.resourceLimits ?? {},
    recentEvents: req.facts?.recentEvents ?? [],
    currentLogs: req.facts?.currentLogs ?? '',
    previousLogs: req.facts?.previousLogs ?? '',
    priorActionSummary:
      `Operator override suggestion: ${suggestion}\n` +
      `Bot plan was: action=${basePlan.action}; ${basePlan.reasoning.slice(0, 400)}`,
    gitManifestPath: basePlan.targetManifestPath,
    ...req.facts,
  };

  log('info', AGENT, 'Parsing operator suggestion via LLM', {
    incidentId: approval.incidentId,
    suggestionLength: suggestion.length,
  });

  const llmPlan = await diagnose(ctx);

  return {
    plan: llmPlan,
    source: 'llm',
    summary: formatPlanSummary(llmPlan),
  };
}

function formatPlanSummary(plan: RemediationPlan): string {
  const lines = [`Action: ${plan.action}`];
  if (plan.proposedPatch.length > 0) {
    lines.push(
      'Patch:',
      ...plan.proposedPatch.map(
        (op) => `  ${op.op} ${op.path}${op.value !== undefined ? ` → ${JSON.stringify(op.value)}` : ''}`
      )
    );
  }
  lines.push(`Reason: ${plan.reasoning.slice(0, 300)}`);
  return lines.join('\n');
}

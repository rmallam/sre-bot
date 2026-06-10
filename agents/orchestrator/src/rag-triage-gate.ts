/**
 * Pre-ReAct RAG triage gate — quick metadata fetch + high-confidence runbook bypass.
 */

import type { DiagnosisContext, RemediationPlan, StartRunRequest } from '../../../shared/src/types.js';
import type { AgentStepRecord } from '../../../shared/src/agent-read-tools.js';
import { agentEvidenceToDiagnosisContext, mergeAgentEvidence } from '../../../shared/src/agent-evidence.js';
import { enrichFactsWithPrimaryFailure } from '../../../shared/src/investigation-diagnosis.js';
import { assessRagBypass, ragBypassReactEnabled } from '../../../shared/src/rag-triage.js';
import {
  isDirectRagBypassPlan,
  parseVerifiedRunbookPlan,
} from '../../../shared/src/rag-runbook-plan.js';
import { platformRagGround } from '../../../shared/src/platform-client.js';
import { log } from '../../../shared/src/http.js';
import { executeAgentReadTool } from './agent-react-tools.js';
import {
  extractErrorSignature,
  inferTargetComponent,
} from './rag-grounding.js';

const AGENT = 'orchestrator-rag-triage';

export interface RagTriageGateResult {
  /** Skip ReAct loop — route to sanitize → plan. */
  ragBypassReact: boolean;
  /** Plan compiled from runbook without plan LLM. */
  ragDirectPlan: boolean;
  factsRaw?: DiagnosisContext;
  agentEvidence?: Partial<DiagnosisContext>;
  agentSteps?: AgentStepRecord[];
  agentFetchedTools?: string[];
  retrievedPlaybook?: string;
  detectedErrorSignature?: string;
  targetComponent?: string;
  pendingPlan?: RemediationPlan;
  ragTriageReason?: string;
  ragTriageSimilarity?: number;
}

function partialFactsFromRequest(request: StartRunRequest): Partial<DiagnosisContext> {
  const cached = request.cachedFacts ?? {};
  const eventBlob = request.eventMessage ?? request.rawMessage ?? '';
  const syntheticEvents =
    eventBlob.trim() && !(cached.recentEvents?.length)
      ? [{ reason: 'Alert', message: eventBlob, type: 'Warning', count: 1, lastTimestamp: '' }]
      : undefined;

  return {
    ...cached,
    recentEvents: cached.recentEvents?.length ? cached.recentEvents : syntheticEvents,
    containerStatuses: cached.containerStatuses ?? [],
    currentLogs: cached.currentLogs ?? '',
    previousLogs: cached.previousLogs ?? '',
  };
}

async function fetchQuickTriageEvidence(
  request: StartRunRequest,
  runId: string
): Promise<{
  evidence: Partial<DiagnosisContext>;
  steps: AgentStepRecord[];
  fetchedTools: string[];
}> {
  const toolCalls = [
    { name: 'investigator.get_workload' as const },
    { name: 'investigator.get_events' as const, input: { limit: 20 } },
  ];

  const settled = await Promise.allSettled(
    toolCalls.map((toolCall) => executeAgentReadTool({ request, runId, toolCall }))
  );

  let evidence: Partial<DiagnosisContext> = partialFactsFromRequest(request);
  const steps: AgentStepRecord[] = [];
  const fetchedTools: string[] = [];
  const at = new Date().toISOString();

  for (let i = 0; i < settled.length; i++) {
    const toolName = toolCalls[i]!.name;
    const result = settled[i]!;
    if (result.status === 'fulfilled') {
      evidence = mergeAgentEvidence(evidence, enrichFactsWithPrimaryFailure(result.value.data));
      steps.push({ tool: toolName, summary: result.value.summary, at });
      fetchedTools.push(toolName);
    } else {
      log('warn', AGENT, 'Quick triage tool failed', {
        tool: toolName,
        incidentId: request.incidentId,
        error: String(result.reason),
      });
    }
  }

  return { evidence, steps, fetchedTools };
}

function buildFactsRaw(
  request: StartRunRequest,
  evidence: Partial<DiagnosisContext>,
  steps: AgentStepRecord[],
  retrievedPlaybook?: string
): DiagnosisContext {
  const facts = agentEvidenceToDiagnosisContext(request, evidence, steps);
  if (retrievedPlaybook?.trim()) {
    facts.retrievedPlaybook = retrievedPlaybook;
  }
  return facts;
}

export async function runRagTriageGate(opts: {
  request: StartRunRequest;
  runId: string;
  mode: StartRunRequest['mode'];
}): Promise<RagTriageGateResult> {
  const empty: RagTriageGateResult = { ragBypassReact: false, ragDirectPlan: false };

  if (opts.mode !== 'diagnose' || !ragBypassReactEnabled()) {
    return empty;
  }

  const { request, runId } = opts;
  let evidence = enrichFactsWithPrimaryFailure(partialFactsFromRequest(request));
  let steps: AgentStepRecord[] = [];
  let fetchedTools: string[] = [...(request.cachedFetchedTools ?? [])];

  let detectedError = extractErrorSignature(evidence as DiagnosisContext);
  if (!detectedError) {
    const quick = await fetchQuickTriageEvidence(request, runId);
    evidence = quick.evidence;
    steps = quick.steps;
    fetchedTools = [...new Set([...fetchedTools, ...quick.fetchedTools])];
    detectedError = extractErrorSignature(evidence as DiagnosisContext);
  } else if (steps.length === 0 && !fetchedTools.length) {
    const quick = await fetchQuickTriageEvidence(request, runId);
    evidence = mergeAgentEvidence(evidence, quick.evidence);
    steps = quick.steps;
    fetchedTools = [...new Set([...fetchedTools, ...quick.fetchedTools])];
  }

  if (!detectedError) {
    log('info', AGENT, 'No error signature for triage — continue ReAct', {
      incidentId: request.incidentId,
    });
    return {
      ...empty,
      agentEvidence: evidence,
      agentSteps: steps,
      agentFetchedTools: fetchedTools,
      ragTriageReason: 'no_error_signature',
    };
  }

  const targetComponent = inferTargetComponent(evidence as DiagnosisContext, detectedError);
  const queryText =
    request.userHints?.join('; ') || request.eventMessage || request.rawMessage || '';

  const rag = await platformRagGround({
    detectedError,
    targetComponent,
    targetWorkload: request.resourceName,
    queryText,
    incidentId: request.incidentId,
  });

  const assessment = assessRagBypass(rag);
  log('info', AGENT, 'RAG triage assessment', {
    incidentId: request.incidentId,
    error: detectedError,
    similarity: assessment.similarity,
    threshold: assessment.threshold,
    eligible: assessment.eligible,
    reason: assessment.reason,
  });

  const base = {
    agentEvidence: evidence,
    agentSteps: steps,
    agentFetchedTools: fetchedTools,
    detectedErrorSignature: detectedError,
    targetComponent,
    ragTriageReason: assessment.reason,
    ragTriageSimilarity: assessment.similarity,
  };

  if (!assessment.eligible || !rag?.playbookMarkdown) {
    return { ...empty, ...base };
  }

  const retrievedPlaybook = rag.playbookMarkdown;
  const factsRaw = buildFactsRaw(request, evidence, steps, retrievedPlaybook);
  factsRaw.detectedErrorSignature = detectedError;

  const parsedPlan = parseVerifiedRunbookPlan(retrievedPlaybook, {
    namespace: request.namespace,
    resourceName: request.resourceName,
    githubRepo: request.githubRepo ?? evidence.githubRepo,
    gitManifestPath: evidence.gitManifestPath,
    errorSignature: detectedError,
  });

  if (parsedPlan && isDirectRagBypassPlan(parsedPlan)) {
    log('info', AGENT, 'RAG direct bypass — skipping ReAct and plan LLM', {
      incidentId: request.incidentId,
      action: parsedPlan.action,
      similarity: assessment.similarity,
    });
    return {
      ragBypassReact: true,
      ragDirectPlan: true,
      factsRaw,
      pendingPlan: parsedPlan,
      retrievedPlaybook,
      ...base,
    };
  }

  log('info', AGENT, 'RAG partial bypass — skipping ReAct, single plan LLM', {
    incidentId: request.incidentId,
    similarity: assessment.similarity,
    parsedAction: parsedPlan?.action,
  });

  return {
    ragBypassReact: true,
    ragDirectPlan: false,
    factsRaw,
    retrievedPlaybook,
    ...base,
  };
}

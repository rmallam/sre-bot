/**
 * LangGraph orchestration — observe → sanitize → plan → authorize → policy → act → verify loop.
 */

import { Annotation, END, START, StateGraph, MemorySaver } from '@langchain/langgraph';
import { v4 as uuidv4 } from 'uuid';
import type {
  ActionRecord,
  AutonomyMode,
  DiagnosisContext,
  RemediateCommand,
  RemediationPlan,
  RunStatus,
  SanitizedFacts,
  SecurityFinding,
  StackDeployAnalysis,
  StartRunRequest,
  VerifyStatus,
  FailureAnalysisResult,
  SpecialistDiagnostic,
} from '../../../shared/src/types.js';
import { provenanceGateNode } from './deploy-source-gate.js';
import { sourceBuildGraphNode, continueAfterSourceBuildApproval } from './source-build-node.js';
import { shouldRunSourceBuild } from '../../../shared/src/deploy/source-build-gate.js';
import { buildHelmDeployPlan } from '../../../shared/src/helm-generator.js';
import { evaluatePolicyGate, getAutonomyMode } from '../../../shared/src/policy.js';
import { evaluateCombinedPolicy, evaluateCompiledToolPolicy } from '../../../shared/src/tool-policy.js';
import { log } from '../../../shared/src/http.js';
import { emitSecurityAudit } from '../../../shared/src/audit-siem.js';
import {
  classifyDeployFailure,
  describeDeployFailureForPlanner,
} from '../../../shared/src/deploy-failure.js';
import {
  mergeFailureAnalysisIntoPlan,
  patchRequestFromFailureAnalysis,
} from '../../../shared/src/failure-plan-merge.js';
import {
  gatherFacts,
  gatherCiFacts,
  sanitizeFacts,
  authorizePlan,
  callPlanLlm,
  callCapabilityPlan,
  callAnalyzeFailure,
  sanitizeTextForLlm,
  executeAction,
  buildRuntimeContext,
  compileAndValidatePlan,
  compileFromToolCalls,
  verifyWorkload,
  verifyAfterRemediation,
  actionNeedsRolloutWait,
  planHasImagePatch,
  gatherStackFacts,
  validatePlanBeforeExecution,
  notifyUser,
  notifyUserUpdate,
  notifyProgress,
  enhanceCiRunFacts,
  isRunRequestIgnored,
  requestHilApproval,
  runRemediationCommand,
  USE_CAPABILITY_PLANNER,
  FAILURE_ANALYSIS_ENABLED,
  type OrchestratorRunContext,
} from './tools.js';
import {
  initRun,
  setRunStatus,
  getRun,
  setRunCompiled,
  setCapabilityPlan,
  mergeRunMetadata,
} from './run-store.js';
import { persistRunOutcome, persistSuggestedPlan } from './persist-outcome.js';
import type { HumanDecision } from '../../../shared/src/remediation-outcome.js';
import { buildDeployPlan } from './deploy-plan.js';
import { humanizeOperatorError } from '../../../shared/src/user-errors.js';
import { modeOutcomeLabel, runStatusOutcomeLabel } from '../../../shared/src/user-outcomes.js';
import { deployHeader, sendDeployProgress } from '../../../shared/src/deploy-notify.js';
import {
  deployReadySuccessMessage,
  watchDeployReadinessAndNotify,
} from '../../../shared/src/deploy-readiness-watch.js';
import { decidePostDeployRecovery } from '../../../shared/src/post-deploy-recovery.js';
import { buildFullCiFailurePlan } from './ci-failure-plan.js';
import { tryParseOperatorSuggestion } from '../../../shared/src/suggest-fix-parse.js';
import {
  assessGitPatchPreflight,
  clusterHotFixFallbackPlan,
  isGitMirrorFailure,
} from '../../../shared/src/git-patch-preflight.js';
import { decideDiagnoseVerifyRecovery } from '../../../shared/src/diagnose-verify-recovery.js';
import { shouldHoldForOperator } from '../../../shared/src/remediation-wait-strategy.js';
import { resolveRunAgentMode } from '../../../shared/src/agent-mode.js';
import type { AgentReadToolCall } from '../../../shared/src/agent-read-tools.js';
import type { AgentStepRecord } from '../../../shared/src/agent-read-tools.js';
import {
  agentDecideNode,
  agentReadNode,
  agentFinalizeNode,
  applyAgentReflect,
  isAgenticDiagnose,
} from './agent-graph-nodes.js';
import { groundRunbookFromFacts } from './rag-grounding.js';
import { ragGroundingEnabled } from '../../../shared/src/platform-client.js';
import {
  adjustPlanForPrimaryFailure,
  enrichFactsWithPrimaryFailure,
  extractPrimaryFailure,
  formatPrimaryFailureMessage,
} from '../../../shared/src/investigation-diagnosis.js';

const AGENT = 'orchestrator-agent';
const MAX_ITERATIONS = parseInt(process.env['AUTONOMY_MAX_ITERATIONS'] ?? '5', 10);

const RunAnnotation = Annotation.Root({
  runId: Annotation<string>,
  incidentId: Annotation<string>,
  request: Annotation<StartRunRequest>,
  mode: Annotation<StartRunRequest['mode']>,
  namespace: Annotation<string>,
  resourceName: Annotation<string>,
  resourceKind: Annotation<StartRunRequest['resourceKind']>,
  factsRaw: Annotation<DiagnosisContext | undefined>,
  factsSanitized: Annotation<SanitizedFacts | undefined>,
  securityFindings: Annotation<SecurityFinding[]>({
    reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
    default: () => [],
  }),
  actionHistory: Annotation<ActionRecord[]>({
    reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
    default: () => [],
  }),
  iteration: Annotation<number>,
  maxIterations: Annotation<number>,
  pendingPlan: Annotation<RemediationPlan | undefined>,
  authorizeForceHil: Annotation<boolean>,
  autonomyMode: Annotation<AutonomyMode>,
  status: Annotation<RunStatus>,
  awaitingHuman: Annotation<boolean>,
  lastError: Annotation<string | undefined>,
  failureAnalysisPending: Annotation<boolean>,
  failureAnalysisUsed: Annotation<boolean>,
  lastFailedPlan: Annotation<RemediationPlan | undefined>,
  postDeployRecoveryUsed: Annotation<boolean>,
  preflightAttempts: Annotation<number>,
  stackDeployPlan: Annotation<StackExecutionPlan | undefined>,
  agentEvidence: Annotation<Partial<DiagnosisContext> | undefined>,
  agentSteps: Annotation<AgentStepRecord[]>,
  agentFetchedTools: Annotation<string[]>,
  agentTurns: Annotation<number>,
  pendingReadTool: Annotation<AgentReadToolCall | undefined>,
  agentGoal: Annotation<string | undefined>,
  agentFocusGoal: Annotation<string | undefined>,
  agentInvestigateComplete: Annotation<boolean>,
  retrievedPlaybook: Annotation<string | undefined>,
  detectedErrorSignature: Annotation<string | undefined>,
  targetComponent: Annotation<string | undefined>,
});

type GraphState = typeof RunAnnotation.State;

async function snapshotRunOutcome(
  runId: string,
  state: GraphState,
  humanDecision?: HumanDecision
): Promise<void> {
  const plan = state.lastFailedPlan ?? state.pendingPlan;
  const decision =
    humanDecision ??
    (state.status === 'awaiting_human'
      ? 'pending'
      : state.request.triggeredBy === 'commander'
        ? 'auto'
        : undefined);
  await persistRunOutcome(runId, {
    status: state.status as RunStatus,
    lastError: state.lastError,
    actionHistory: state.actionHistory ?? [],
    plan,
    humanDecision: decision,
    ragSeed: {
      detectedError:
        state.detectedErrorSignature ?? state.factsSanitized?.detectedErrorSignature,
      targetComponent: state.targetComponent ?? state.factsSanitized?.targetComponent,
      mode: state.mode,
    },
  }).catch(() => undefined);
}

interface StackServiceExecutionPlan {
  serviceName: string;
  plan: RemediationPlan;
}

interface StackExecutionPlan {
  analysis: StackDeployAnalysis;
  services: StackServiceExecutionPlan[];
}

function runCtx(state: GraphState): OrchestratorRunContext {
  return {
    runId: state.runId,
    incidentId: state.incidentId,
    request: state.request,
    namespace: state.namespace,
    resourceName: state.resourceName,
    resourceKind: state.resourceKind,
    mode: state.mode,
    pendingPlan: state.pendingPlan,
    ciRun: state.factsRaw?.ciRun ?? state.factsSanitized?.ciRun,
  };
}

function priorSummary(history: ActionRecord[]): string | undefined {
  if (history.length === 0) return undefined;
  return history.map((h) => `${h.action}:${h.success ? 'ok' : 'fail'}`).join('; ');
}

async function deriveSpecialistDiagnostics(
  facts: DiagnosisContext
): Promise<SpecialistDiagnostic[]> {
  const workload = async (): Promise<SpecialistDiagnostic> => {
    const restarts = (facts.containerStatuses ?? []).filter((s) => {
      const rc = (s as { restartCount?: number }).restartCount ?? 0;
      return rc > 0;
    }).length;
    const findings = restarts > 0 ? [`${restarts} containers with restartCount > 0`] : ['No high restart signal'];
    return { specialist: 'workload', summary: findings[0]!, confidence: restarts > 0 ? 0.8 : 0.55, findings };
  };
  const network = async (): Promise<SpecialistDiagnostic> => {
    const events = (facts.recentEvents ?? []).map((e) => `${e.reason} ${e.message}`.toLowerCase());
    const hit = events.filter((e) => /\b(service|endpoint|dns|ingress|connection refused|timeout)\b/.test(e));
    return {
      specialist: 'network',
      summary: hit.length > 0 ? 'Network/routing clues present in events' : 'No strong network clues',
      confidence: hit.length > 0 ? 0.72 : 0.45,
      findings: hit.slice(0, 3),
    };
  };
  const database = async (): Promise<SpecialistDiagnostic> => {
    const logBlob = `${facts.currentLogs ?? ''}\n${facts.previousLogs ?? ''}`.toLowerCase();
    const patterns = ['too many connections', 'connection pool', 'sqlstate', 'deadlock', 'database is locked'];
    const hits = patterns.filter((p) => logBlob.includes(p));
    return {
      specialist: 'database',
      summary: hits.length > 0 ? 'Database pressure signals present in logs' : 'No direct database signal',
      confidence: hits.length > 0 ? 0.7 : 0.4,
      findings: hits.map((h) => `matched pattern: ${h}`),
    };
  };

  const results = await Promise.allSettled([workload(), network(), database()]);
  return results
    .filter((r): r is PromiseFulfilledResult<SpecialistDiagnostic> => r.status === 'fulfilled')
    .map((r) => r.value);
}

async function observeNode(state: GraphState): Promise<Partial<GraphState>> {
  if (state.mode === 'ci-failure') {
    try {
      if (state.request.platform && state.request.channelId) {
        await notifyProgress(runCtx(state), 'Fetching CI logs from GitHub…');
      }
      let ciRun = await gatherCiFacts(state.request);
      ciRun = await enhanceCiRunFacts(ciRun, state.incidentId);
      const facts: DiagnosisContext = {
        incidentId: state.incidentId,
        mode: state.mode,
        namespace: state.namespace,
        resourceKind: state.resourceKind,
        resourceName: state.resourceName,
        recentEvents: [],
        currentLogs: ciRun.logExcerpt ?? '',
        previousLogs: '',
        ciRun,
        githubRepo: ciRun.githubRepo,
      };
      return { factsRaw: facts, iteration: state.iteration + 1 };
    } catch (err) {
      const errMsg = String(err);
      if (state.request.platform && state.request.channelId) {
        await notifyUser(
          runCtx(state),
          `❌ Could not fetch CI run:\n${humanizeOperatorError(errMsg)}`
        );
      }
      return { status: 'failed', lastError: errMsg, iteration: state.iteration + 1 };
    }
  }

  if (
    state.mode === 'pre-deploy' &&
    state.request.platform &&
    state.request.channelId &&
    state.iteration === 0
  ) {
    await notifyProgress(runCtx(state), 'Gathering cluster and repository information…');
  }

  if (
    state.mode === 'diagnose' &&
    state.request.platform &&
    state.request.channelId &&
    state.iteration === 0 &&
    !isAgenticDiagnose(state.request, state.mode)
  ) {
    await notifyProgress(runCtx(state), 'Gathering logs, metrics, and cluster evidence…');
  }

  const baseFacts = await gatherFacts(state.request);
  const specialistDiagnostics =
    baseFacts.specialistDiagnostics && baseFacts.specialistDiagnostics.length > 0
      ? baseFacts.specialistDiagnostics
      : await deriveSpecialistDiagnostics(baseFacts);
  const facts: DiagnosisContext = enrichFactsWithPrimaryFailure({
    ...baseFacts,
    specialistDiagnostics,
  });
  const iteration = state.iteration + 1;

  if (
    state.mode === 'diagnose' &&
    state.request.platform &&
    state.request.channelId &&
    !isAgenticDiagnose(state.request, state.mode)
  ) {
    const primary = extractPrimaryFailure(facts);
    if (primary) {
      await notifyUser(runCtx(state), formatPrimaryFailureMessage(primary));
    }
  }

  if (
    state.mode === 'pre-deploy' &&
    facts.cloneError &&
    !facts.gitManifestPath
  ) {
    const ctx = runCtx(state);
    const refNote = facts.resolvedGitRef
      ? ` (resolved ref: ${facts.resolvedGitRef})`
      : '';
    const errMsg = facts.cloneError;
    await notifyUser(
      ctx,
      `❌ Could not read the deploy repo${refNote}:\n${errMsg}\n\n` +
        `Tip: specify a branch, e.g. \`@master\` or \`on branch develop\`.`
    );
    return { factsRaw: facts, iteration, status: 'failed', lastError: errMsg };
  }

  if (facts.resolvedGitRef && state.request.gitRef !== facts.resolvedGitRef) {
    log('info', AGENT, 'Using resolved git ref from clone', {
      incidentId: state.incidentId,
      requested: state.request.gitRef,
      resolved: facts.resolvedGitRef,
    });
  }

  if (
    state.mode === 'pre-deploy' &&
    facts.namespaceExists === false &&
    !state.request.createNamespace &&
    state.request.platform &&
    state.request.channelId
  ) {
    await sendDeployProgress(
      {
        incidentId: state.incidentId,
        platform: state.request.platform,
        channelId: state.request.channelId,
      },
      deployHeader(state.resourceName, state.namespace)
    );
    await notifyUser(
      runCtx({ ...state, factsRaw: facts }),
      `Namespace \`${state.namespace}\` does not exist yet.\n\n` +
        `Reply **yes** or **create namespace** and I will create it and continue this deploy.\n` +
        `Reply **cancel** to stop.`
    );
    return {
      factsRaw: facts,
      iteration,
      status: 'awaiting_human',
      awaitingHuman: true,
      lastError: 'namespace_missing_awaiting_user',
    };
  }

  if (state.mode === 'pre-deploy' && state.request.platform && state.request.channelId) {
    const nsExists = facts.namespaceExists === true;
    await sendDeployProgress(
      {
        incidentId: state.incidentId,
        platform: state.request.platform,
        channelId: state.request.channelId,
      },
      deployHeader(state.resourceName, state.namespace)
    );
    await sendDeployProgress(
      {
        incidentId: state.incidentId,
        platform: state.request.platform,
        channelId: state.request.channelId,
      },
      nsExists
        ? `Namespace ${state.namespace} already exists in the cluster.`
        : `Namespace ${state.namespace} is not in the cluster yet — deploy will create it.`
    );
    if (facts.needsHelmGeneration) {
      await sendDeployProgress(
        {
          incidentId: state.incidentId,
          platform: state.request.platform,
          channelId: state.request.channelId,
        },
        'Repository has no Kubernetes manifests — will generate a Helm chart and apply it.'
      );
    }
  }

  return { factsRaw: facts, iteration };
}

function agentNotify(state: GraphState) {
  const ctx = runCtx(state);
  return {
    progress: async (summary: string) => {
      if (state.request.platform && state.request.channelId) {
        await notifyUserUpdate(ctx, {
          kind: 'agent_step',
          incidentId: state.incidentId,
          runId: state.runId,
          mode: state.mode,
          progressStep: summary,
          namespace: state.namespace,
          resourceName: state.resourceName,
        });
      }
    },
    user: async (message: string) => {
      await notifyUser(ctx, message);
    },
  };
}

async function agentDecideGraphNode(state: GraphState): Promise<Partial<GraphState>> {
  if (
    state.mode === 'diagnose' &&
    state.request.platform &&
    state.request.channelId &&
    state.iteration === 0 &&
    (state.agentTurns ?? 0) === 0
  ) {
    await notifyProgress(runCtx(state), 'Investigating step by step…');
  }
  return agentDecideNode(state, agentNotify(state));
}

async function agentReadGraphNode(state: GraphState): Promise<Partial<GraphState>> {
  return agentReadNode(state, agentNotify(state));
}

async function agentFinalizeGraphNode(state: GraphState): Promise<Partial<GraphState>> {
  return agentFinalizeNode(state, deriveSpecialistDiagnostics, gatherFacts);
}

async function sanitizeNode(state: GraphState): Promise<Partial<GraphState>> {
  if (!state.factsRaw) return { status: 'failed', lastError: 'No facts' };
  const { sanitized, findings, blocked } = await sanitizeFacts(state.factsRaw);
  if (blocked) {
    await emitSecurityAudit({
      eventType: 'sanitize_blocked',
      incidentId: state.incidentId,
      runId: state.runId,
      message: 'Blocked',
      timestamp: new Date().toISOString(),
    });
    return { status: 'escalated', securityFindings: findings, lastError: 'Sensitive data blocked' };
  }
  return { factsSanitized: sanitized, securityFindings: findings };
}

async function ragGroundingNode(state: GraphState): Promise<Partial<GraphState>> {
  if (state.mode !== 'diagnose' || !state.factsSanitized || !ragGroundingEnabled()) {
    return {};
  }

  const queryText =
    state.request.userHints?.join('; ') ||
    state.request.eventMessage ||
    state.request.rawMessage ||
    '';

  const grounded = await groundRunbookFromFacts(state.factsSanitized, {
    incidentId: state.incidentId,
    resourceName: state.resourceName,
    queryText,
  });

  if (!grounded.detectedError && !grounded.retrievedPlaybook) {
    return {};
  }

  const factsSanitized: SanitizedFacts = {
    ...state.factsSanitized,
    retrievedPlaybook: grounded.retrievedPlaybook || state.factsSanitized.retrievedPlaybook,
    detectedErrorSignature: grounded.detectedError || state.factsSanitized.detectedErrorSignature,
    targetComponent: grounded.targetComponent || state.factsSanitized.targetComponent,
    priorActionSummary: [
      state.factsSanitized.priorActionSummary,
      grounded.found
        ? `rag_playbook=grounded similarity=${grounded.similarity.toFixed(2)} error=${grounded.detectedError}`
        : grounded.detectedError
          ? `rag_playbook=miss error=${grounded.detectedError}`
          : undefined,
    ]
      .filter(Boolean)
      .join('; '),
  };

  if (state.request.platform && state.request.channelId && grounded.found) {
    await notifyUserUpdate(runCtx(state), {
      kind: 'agent_step',
      incidentId: state.incidentId,
      runId: state.runId,
      mode: state.mode,
      progressStep: `📚 Runbook grounded for ${grounded.detectedError} (${Math.round(grounded.similarity * 100)}% match)`,
      namespace: state.namespace,
      resourceName: state.resourceName,
    });
  }

  if (grounded.detectedError) {
    await mergeRunMetadata(state.runId, {
      ragContext: {
        detectedError: grounded.detectedError,
        targetComponent: grounded.targetComponent,
      },
    }).catch(() => undefined);
  }

  return {
    factsSanitized,
    retrievedPlaybook: grounded.retrievedPlaybook,
    detectedErrorSignature: grounded.detectedError,
    targetComponent: grounded.targetComponent,
  };
}

async function sourceBuildNode(state: GraphState): Promise<Partial<GraphState>> {
  return sourceBuildGraphNode(state);
}

async function planNode(state: GraphState): Promise<Partial<GraphState>> {
  if (!state.factsSanitized) return { status: 'failed', lastError: 'No sanitized facts' };

  const operatorHint =
    state.request.userHints?.join('; ') ||
    state.request.eventMessage?.trim() ||
    state.request.rawMessage?.trim() ||
    '';
  if (operatorHint && state.mode === 'diagnose') {
    const rulePlan = tryParseOperatorSuggestion(operatorHint, {
      namespace: state.namespace,
      resourceKind: state.resourceKind,
      resourceName: state.resourceName,
      basePlan: {
        action: 'git_patch',
        rootCause: 'Operator-provided fix after escalation',
        reasoning: operatorHint,
        severity: 'MEDIUM',
        proposedPatch: [],
        targetManifestPath: `deployments/${state.resourceName}.yaml`,
        commitMessage: `fix: operator suggestion`,
        rollbackSafe: true,
        patchTarget: 'cluster',
      },
    });
    if (rulePlan) {
      const preflight = assessGitPatchPreflight({
        plan: rulePlan,
        mode: state.mode,
        resourceKind: state.resourceKind,
        resourceName: state.resourceName,
        facts: state.factsSanitized ?? state.factsRaw,
      });
      if (!preflight.allowed) {
        const blocked = preflight.issues.map((i) => i.message).join('; ');
        await notifyUser(
          runCtx(state),
          `That fix needs more evidence before I can propose it:\n${blocked}\n\n` +
            `I'll ask for your input — suggest a cluster hot-fix (image tag, pull secret) when prompted.`
        );
        return {
          pendingPlan: {
            action: 'escalate_human',
            rootCause: 'Operator suggestion blocked by preflight',
            reasoning: blocked,
            severity: 'HIGH',
            proposedPatch: [],
            targetManifestPath: '',
            commitMessage: `fix: review ${state.resourceName}`,
            rollbackSafe: true,
            patchTarget: 'cluster',
          },
        };
      }
      return { pendingPlan: preflight.normalizedPlan ?? rulePlan };
    }
  }

  if (state.mode === 'pre-deploy' && state.request.stackServices && state.request.stackServices.length > 1) {
    const analysis = await gatherStackFacts(state.request);
    const servicePlans: StackServiceExecutionPlan[] = analysis.services.map((svc) => {
      const generated = buildHelmDeployPlan({
        appName: svc.name,
        namespace: state.namespace,
        githubRepo: svc.githubRepo,
        gitRef: svc.resolvedGitRef ?? svc.gitRef ?? 'main',
        repoSignals: svc.repoSignals,
      });
      const direct = state.request.deployStrategy === 'direct';
      return {
        serviceName: svc.name,
        plan: direct
          ? {
              ...generated,
              action: 'repo_apply',
              targetRepo: 'app',
              commitMessage: `feat(deploy): direct deploy generated Helm chart for ${svc.name}`,
            }
          : generated,
      };
    });

    const depSummary =
      analysis.dependencyEdges.length > 0
        ? analysis.dependencyEdges.map((e) => `${e.from}→${e.to}`).join(', ')
        : 'none detected';
    const stackSummaryPlan: RemediationPlan = {
      action: 'helm_deploy',
      rootCause: `Deploy requested for ${analysis.services.length} related services`,
      reasoning:
        `Inferred service communication edges: ${depSummary}. ` +
        `Deploy order: ${analysis.deploymentOrder.join(' -> ')}.` +
        (analysis.hasCycle
          ? ' Cycle detected in dependencies, using input order for safety.'
          : ' Dependencies resolved with topological order.'),
      severity: 'MEDIUM',
      proposedPatch: [],
      targetManifestPath: `stack/${analysis.stackName}`,
      commitMessage: `feat(deploy): deploy stack ${analysis.stackName}`,
      rollbackSafe: true,
      targetRepo: state.request.deployStrategy === 'direct' ? 'app' : 'both',
      githubRepo: state.request.githubRepo,
      gitRef: state.request.gitRef ?? 'main',
    };

    return {
      pendingPlan: stackSummaryPlan,
      stackDeployPlan: {
        analysis,
        services: servicePlans,
      },
    };
  }

  const ctx: DiagnosisContext = {
    ...state.factsSanitized,
    priorActionSummary: priorSummary(state.actionHistory),
    githubRepo: state.factsSanitized.githubRepo ?? state.request.githubRepo,
  };

  if (resolveRunAgentMode(state.request).useCapabilityPlanner && state.mode === 'diagnose') {
    const cap = await callCapabilityPlan(ctx);
    const runtimeCtx = {
      incidentId: state.incidentId,
      runId: state.runId,
      mode: state.mode,
      namespace: state.namespace,
      resourceName: state.resourceName,
      resourceKind: state.resourceKind,
      request: state.request,
      plan: cap.remediationPlan,
    };
    const compiled = compileFromToolCalls(cap.toolCalls, runtimeCtx);
    await setCapabilityPlan(state.runId, cap.toolCalls, compiled);
    return { pendingPlan: cap.remediationPlan };
  }

  if (state.mode === 'ci-failure') {
    const ciRun = state.factsRaw?.ciRun ?? state.factsSanitized?.ciRun;
    if (!ciRun) {
      return { status: 'failed', lastError: 'No CI run facts available' };
    }
    const plan = await buildFullCiFailurePlan(ciRun, state.incidentId);
    await mergeRunMetadata(state.runId, { ciRun, remediationPlan: plan });
    if (state.request.platform && state.request.channelId) {
      await notifyUserUpdate(runCtx(state), {
        kind: 'ci_diagnosis',
        incidentId: state.incidentId,
        runId: state.runId,
        ciRun,
        repo: ciRun.githubRepo,
        detailAvailable: true,
      });
      if (plan.action === 'coding_agent_handoff') {
        await notifyUserUpdate(runCtx(state), {
          kind: 'coding_agent_handoff',
          incidentId: state.incidentId,
          runId: state.runId,
          codingAgentMaxAttempts: parseInt(
            process.env['CODING_AGENT_MAX_ITERATIONS'] ??
              process.env['CODING_AGENT_MAX_ATTEMPTS'] ??
              '5',
            10
          ),
          technicalMessage: ciRun.diagnosis?.summary,
        });
      }
    }
    return { pendingPlan: plan };
  }

  const plan =
    state.mode === 'pre-deploy'
      ? await buildDeployPlan(ctx, state.request)
      : adjustPlanForPrimaryFailure(
          ctx,
          await callPlanLlm(ctx, state.actionHistory)
        );

  if (state.mode === 'pre-deploy' && state.request.platform && state.request.channelId) {
    const existing = state.factsSanitized?.existingDeployments ?? [];
    if (existing.length > 0) {
      const preview = existing.slice(0, 6).join(', ');
      const suffix = existing.length > 6 ? ` (+${existing.length - 6} more)` : '';
      await sendDeployProgress(
        {
          incidentId: state.incidentId,
          platform: state.request.platform,
          channelId: state.request.channelId,
        },
        `Namespace \`${state.namespace}\` already has deployment(s): ${preview}${suffix}. ` +
          `If this is a reinstall, confirm in the approval step — otherwise cancel the run.`
      );
    }

    const actionLabel =
      plan.action === 'repo_apply'
        ? 'direct apply to the cluster (no Git push)'
        : plan.action === 'helm_deploy'
          ? 'GitOps via Helm + Argo CD'
          : plan.action;
    await sendDeployProgress(
      {
        incidentId: state.incidentId,
        platform: state.request.platform,
        channelId: state.request.channelId,
      },
      `Plan ready: ${actionLabel}.`
    );
  }

  return { pendingPlan: plan };
}

async function preflightNode(state: GraphState): Promise<Partial<GraphState>> {
  if (!state.pendingPlan) return { status: 'failed', lastError: 'No plan to validate' };
  const validation = await validatePlanBeforeExecution({
    incidentId: state.incidentId,
    namespace: state.namespace,
    mode: state.mode,
    resourceKind: state.resourceKind,
    resourceName: state.resourceName,
    plan: state.pendingPlan,
    facts: state.factsSanitized ?? state.factsRaw,
  });

  if (validation.allowed) {
    let pendingPlan = state.pendingPlan;
    if (pendingPlan?.action === 'git_patch') {
      const local = assessGitPatchPreflight({
        plan: pendingPlan,
        mode: state.mode,
        resourceKind: state.resourceKind,
        resourceName: state.resourceName,
        facts: state.factsSanitized ?? state.factsRaw,
      });
      if (local.normalizedPlan) {
        pendingPlan = local.normalizedPlan;
      }
    }
    if (validation.requiresHumanApproval) {
      await notifyUser(
        runCtx(state),
        `Pre-flight validator marked this plan as sensitive; human approval will be required.\n${validation.summary}`
      );
    }
    return {
      pendingPlan,
      authorizeForceHil: state.authorizeForceHil || validation.requiresHumanApproval,
    };
  }

  const issuesText = validation.issues.map((i) => `${i.code}: ${i.message}`).join('; ');
  if (state.preflightAttempts < 1 && state.factsSanitized) {
    await notifyUser(
      runCtx(state),
      `Pre-flight validator rejected the plan; attempting one safer re-plan.\n${validation.summary}`
    );
    const revisedCtx: DiagnosisContext = {
      ...state.factsSanitized,
      priorActionSummary: `${priorSummary(state.actionHistory) ?? ''}; preflight_issues=${issuesText}`,
      githubRepo: state.factsSanitized.githubRepo ?? state.request.githubRepo,
    };
    const revised =
      state.mode === 'pre-deploy'
        ? await buildDeployPlan(revisedCtx, state.request)
        : await callPlanLlm(revisedCtx, state.actionHistory);
    const revisedValidation = await validatePlanBeforeExecution({
      incidentId: state.incidentId,
      namespace: state.namespace,
      mode: state.mode,
      resourceKind: state.resourceKind,
      resourceName: state.resourceName,
      plan: revised,
      facts: state.factsSanitized ?? state.factsRaw,
    });
    if (!revisedValidation.allowed) {
      await notifyUser(
        runCtx(state),
        `Re-planned candidate also failed pre-flight validation: ${revisedValidation.summary}`
      );
      return {
        status: 'escalated',
        lastError: `Pre-flight validation failed after re-plan: ${revisedValidation.summary}`,
        authorizeForceHil: true,
        preflightAttempts: state.preflightAttempts + 1,
      };
    }
    return {
      pendingPlan: revised,
      preflightAttempts: state.preflightAttempts + 1,
      authorizeForceHil: true,
    };
  }

  await notifyUser(
    runCtx(state),
    `Pre-flight validator blocked execution: ${validation.summary}\n${issuesText}`
  );
  return {
    status: 'escalated',
    lastError: `Pre-flight validation failed: ${validation.summary}`,
    authorizeForceHil: true,
  };
}

async function authorizeNode(state: GraphState): Promise<Partial<GraphState>> {
  if (!state.pendingPlan) return { status: 'failed' };
  const auth = await authorizePlan(
    state.pendingPlan,
    state.namespace,
    state.resourceName,
    state.resourceKind,
    state.mode,
    state.incidentId,
    state.request.githubRepo
  );
  if (!auth.allowed) {
    return { status: 'escalated', securityFindings: auth.findings, lastError: auth.reason, authorizeForceHil: true };
  }
  return { authorizeForceHil: auth.forceHil, securityFindings: auth.findings };
}

async function policyNode(state: GraphState): Promise<Partial<GraphState>> {
  if (!state.pendingPlan) return { status: 'failed' };

  if (state.pendingPlan.action === 'escalate_human') {
    await notifyUser(
      runCtx(state),
      `🙋 I need a human to look at this:\n${state.pendingPlan.reasoning}`
    );
    return { status: 'escalated', awaitingHuman: true };
  }

  if (state.pendingPlan.action === 'noop') {
    if (state.mode !== 'ci-failure') {
      const root = state.pendingPlan.rootCause?.trim();
      const reasoning = state.pendingPlan.reasoning?.trim();
      const msg =
        root && root.length > 10
          ? `ℹ️ Investigation summary:\n${root}${reasoning ? `\n\n${reasoning.slice(0, 600)}` : ''}`
          : `ℹ️ No automated action recommended for this incident.`;
      await notifyUser(runCtx(state), msg);
    }
    return { status: 'succeeded' };
  }

  const runtimeCtx = buildRuntimeContext(runCtx(state));
  const stored = await getRun(state.runId);
  const compiled = stored?.compiled ?? compileAndValidatePlan(runtimeCtx);

  if (!compiled.validation.ok) {
    return {
      status: 'failed',
      lastError: `Compiler validation failed: ${compiled.validation.errors.join('; ')}`,
    };
  }

  await setRunCompiled(state.runId, compiled);

  const planGate = evaluatePolicyGate(state.pendingPlan, state.namespace, state.authorizeForceHil);
  const toolGate = evaluateCompiledToolPolicy(compiled, state.namespace, state.authorizeForceHil);
  const gate = evaluateCombinedPolicy(planGate, toolGate);

  if (!gate.autoExecute) {
    if (
      state.mode === 'ci-failure' &&
      state.pendingPlan.action === 'cicd_open_pr' &&
      state.request.platform &&
      state.request.channelId
    ) {
      await notifyUserUpdate(runCtx(state), {
        kind: 'ci_approval_workflow_pr',
        incidentId: state.incidentId,
        pendingAction: 'cicd_open_pr',
        workflowFilePath:
          state.pendingPlan.cicd?.workflowFilePath ?? state.pendingPlan.targetManifestPath,
        repo: state.pendingPlan.githubRepo,
      });
    } else if (
      state.mode === 'ci-failure' &&
      state.pendingPlan.action === 'cicd_code_pr' &&
      state.request.platform &&
      state.request.channelId
    ) {
      await notifyUserUpdate(runCtx(state), {
        kind: 'ci_approval_code_pr',
        incidentId: state.incidentId,
        pendingAction: 'cicd_code_pr',
        codeFilePaths: state.pendingPlan.cicd?.codePatches?.map((p) => p.path),
        repo: state.pendingPlan.githubRepo,
      });
    } else if (
      state.mode === 'ci-failure' &&
      state.pendingPlan.action === 'coding_agent_handoff' &&
      state.request.platform &&
      state.request.channelId
    ) {
      await notifyUserUpdate(runCtx(state), {
        kind: 'ci_approval_coding_agent',
        incidentId: state.incidentId,
        runId: state.runId,
        pendingAction: 'coding_agent_handoff',
        repo: state.pendingPlan.githubRepo,
        codingAgentMaxAttempts: parseInt(
          process.env['CODING_AGENT_MAX_ITERATIONS'] ??
            process.env['CODING_AGENT_MAX_ATTEMPTS'] ??
            '5',
          10
        ),
      });
    } else if (
      state.mode === 'ci-failure' &&
      state.pendingPlan.action === 'cicd_rerun' &&
      state.request.platform &&
      state.request.channelId
    ) {
      await notifyUserUpdate(runCtx(state), {
        kind: 'ci_approval_rerun',
        incidentId: state.incidentId,
        pendingAction: 'cicd_rerun',
        repo: state.pendingPlan.githubRepo,
      });
    } else if (
      state.request.platform &&
      state.request.channelId &&
      !(
        state.mode === 'ci-failure' &&
        (state.pendingPlan.action === 'cicd_open_pr' ||
          state.pendingPlan.action === 'cicd_code_pr' ||
          state.pendingPlan.action === 'coding_agent_handoff' ||
          state.pendingPlan.action === 'cicd_rerun')
      )
    ) {
      await notifyUserUpdate(runCtx(state), {
        kind: 'hil_required',
        incidentId: state.incidentId,
        runId: state.runId,
        mode: state.mode,
        pendingAction: state.pendingPlan.action,
        namespace: state.namespace,
        resourceName: state.resourceName,
        detailAvailable: true,
        technicalMessage:
          state.pendingPlan.rootCause?.slice(0, 400) ??
          state.pendingPlan.reasoning?.slice(0, 400) ??
          `Approve to ${state.pendingPlan.action.replace(/_/g, ' ')}.`,
      });
    }
    const run = await getRun(state.runId);
    if (run?.status !== 'awaiting_human') {
      await requestHilApproval(runCtx(state), state.pendingPlan, state.iteration, state.maxIterations);
      await setRunStatus(state.runId, 'awaiting_human');
      await persistSuggestedPlan(state.runId, state.pendingPlan);
    }
    await snapshotRunOutcome(state.runId, { ...state, status: 'awaiting_human' } as GraphState, 'pending');
    return { status: 'awaiting_human', awaitingHuman: true };
  }
  return { awaitingHuman: false };
}

async function actNode(state: GraphState): Promise<Partial<GraphState>> {
  if (!state.pendingPlan) return { status: 'failed' };
  if (state.stackDeployPlan && state.mode === 'pre-deploy') {
    const stackResult = await executeStackDeployment(state, state.stackDeployPlan);
    const record: ActionRecord = {
      action: state.pendingPlan.action,
      success: stackResult.success,
      summary: stackResult.summary,
      at: new Date().toISOString(),
    };
    if (!stackResult.success) {
      return {
        actionHistory: [record],
        status: 'failed',
        lastError: stackResult.error ?? stackResult.summary,
      };
    }
    return { actionHistory: [record], status: 'succeeded' };
  }
  if (state.mode === 'pre-deploy' && state.request.platform && state.request.channelId) {
    await sendDeployProgress(
      {
        incidentId: state.incidentId,
        platform: state.request.platform,
        channelId: state.request.channelId,
      },
      'Applying changes to the cluster now…'
    );
  }
  const result = await executeAction(runCtx(state), {
    iteration: state.iteration,
    maxIterations: state.maxIterations,
  });
  if (result.paused) {
    return { status: 'awaiting_human', awaitingHuman: true };
  }
  const record: ActionRecord = {
    action: state.pendingPlan.action,
    success: result.success,
    summary: result.error ?? result.summary ?? 'executed',
    commitUrls: result.commitUrls,
    toolTranscript: result.transcript,
    verifyStatus:
      result.verifyHealthy === true ? 'healthy' : result.verifyHealthy === false ? 'degraded' : undefined,
    at: new Date().toISOString(),
  };

  if (!result.success && state.pendingPlan?.action === 'git_patch' && isGitMirrorFailure(result.error)) {
    const fallback = clusterHotFixFallbackPlan(state.pendingPlan, result.error);
    await notifyUser(
      runCtx(state),
      `Git repository patch failed.\n${humanizeOperatorError(result.error ?? '')}\n\n` +
        `Approve the next prompt to apply the **same change directly on the cluster** (hot-fix).`
    );
    return {
      actionHistory: [record],
      pendingPlan: fallback,
      authorizeForceHil: true,
      lastError: result.error,
    };
  }

  if (!result.success && FAILURE_ANALYSIS_ENABLED && !state.failureAnalysisUsed) {
    const priorFailures = state.actionHistory.filter((a) => !a.success).length;
    if (priorFailures < 1) {
      log('info', AGENT, 'Act failed — routing to failure analyst', {
        incidentId: state.incidentId,
        mode: state.mode,
        error: result.error?.slice(0, 200),
      });
      return {
        actionHistory: [record],
        pendingPlan: undefined,
        lastError: result.error,
        lastFailedPlan: state.pendingPlan,
        failureAnalysisPending: true,
        factsSanitized: state.factsSanitized
          ? {
              ...state.factsSanitized,
              priorActionSummary: describeDeployFailureForPlanner(result.error),
            }
          : state.factsSanitized,
      };
    }
  }

  if (!result.success) {
    return { actionHistory: [record], status: 'failed', lastError: result.error };
  }

  return { actionHistory: [record] };
}

async function executeStackDeployment(
  state: GraphState,
  stack: StackExecutionPlan
): Promise<{ success: boolean; summary: string; error?: string }> {
  const serviceMap = new Map(stack.services.map((s) => [s.serviceName, s]));
  const deployed: string[] = [];

  for (const serviceName of stack.analysis.deploymentOrder) {
    const svc = serviceMap.get(serviceName);
    if (!svc) {
      return {
        success: false,
        summary: `Missing execution plan for service ${serviceName}`,
        error: `Missing execution plan for service ${serviceName}`,
      };
    }

    await notifyUser(
      runCtx(state),
      `Applying ${svc.plan.action} for service \`${serviceName}\` in \`${state.namespace}\`...`
    );

    const cmd: RemediateCommand = {
      incidentId: `${state.incidentId}:${serviceName}`,
      triggeredBy: state.request.triggeredBy,
      triggeredAt: state.request.triggeredAt,
      namespace: state.namespace,
      resourceKind: 'Deployment',
      resourceName: serviceName,
      mode: 'pre-deploy',
      plan: svc.plan,
      approvedBy: state.request.requestedBy ?? 'operator',
      approvedAt: new Date().toISOString(),
      approvedVia: state.request.platform ?? 'web',
      requestedBy: state.request.requestedBy,
      platform: state.request.platform,
      channelId: state.request.channelId,
      runId: state.runId,
      executionOptions: { createNamespace: state.request.createNamespace },
    };
    const result = await runRemediationCommand(cmd);
    if (!result.success) {
      return {
        success: false,
        summary: `Service ${serviceName} failed`,
        error: result.error ?? `Failed deploying ${serviceName}`,
      };
    }

    const verify = await verifyWorkload(state.namespace, serviceName, state.incidentId);
    if (!verify.healthy) {
      return {
        success: false,
        summary: `Service ${serviceName} deployed but health check failed`,
        error: verify.message,
      };
    }
    deployed.push(serviceName);
  }

  return {
    success: true,
    summary: `Stack deployed successfully in order: ${deployed.join(' -> ')}`,
  };
}

async function analyzeFailureNode(state: GraphState): Promise<Partial<GraphState>> {
  if (!state.factsSanitized || !state.lastError) {
    return { status: 'failed', lastError: state.lastError ?? 'No error context', failureAnalysisPending: false };
  }

  const lastRecord = state.actionHistory[state.actionHistory.length - 1];
  const failedAction = lastRecord?.action ?? state.lastFailedPlan?.action ?? 'repo_apply';
  const classified = classifyDeployFailure(state.lastError);
  const sanitizedError = await sanitizeTextForLlm(state.lastError, state.incidentId);

  if (state.mode === 'pre-deploy' && state.request.platform && state.request.channelId) {
    await sendDeployProgress(
      {
        incidentId: state.incidentId,
        platform: state.request.platform,
        channelId: state.request.channelId,
      },
      'Analyzing what went wrong (not retrying blindly)…'
    );
  }

  let analysis: FailureAnalysisResult;
  try {
    analysis = await callAnalyzeFailure({
      incidentId: state.incidentId,
      mode: state.mode,
      namespace: state.namespace,
      resourceName: state.resourceName,
      resourceKind: state.resourceKind,
      failedAction,
      errorMessage: sanitizedError,
      failureKind: classified.kind,
      alternateStrategyMayHelp: classified.alternateStrategyMayHelp,
      actionHistorySummary: priorSummary(state.actionHistory) ?? '',
      facts: state.factsSanitized,
      githubRepo: state.request.githubRepo ?? state.factsSanitized.githubRepo,
      gitRef: state.request.gitRef ?? state.factsSanitized.resolvedGitRef,
      deployStrategy: state.request.deployStrategy,
    });
  } catch (err) {
    log('error', AGENT, 'Failure analyst call failed', { incidentId: state.incidentId, error: String(err) });
    return {
      status: 'failed',
      lastError: state.lastError,
      failureAnalysisPending: false,
      failureAnalysisUsed: true,
    };
  }

  if (state.mode === 'pre-deploy' && state.request.platform && state.request.channelId) {
    await sendDeployProgress(
      {
        incidentId: state.incidentId,
        platform: state.request.platform,
        channelId: state.request.channelId,
      },
      analysis.operatorMessage
    );
  }

  // Reusable missing-resource approval block:
  // if analyst identifies a missing resource that can be created, ask user first.
  if (
    analysis.missingResource?.canAutoCreate &&
    analysis.missingResource.kind === 'namespace' &&
    state.mode === 'pre-deploy' &&
    state.request.platform &&
    state.request.channelId
  ) {
    const missing = analysis.missingResource;
    await notifyUser(
      runCtx(state),
      `Missing resource detected: ${missing.kind} \`${missing.name}\`.\n` +
        `${missing.reason}\n\n` +
        `Reply **yes** or **create ${missing.kind}** and I will create it and continue.\n` +
        `Reply **cancel** to stop.`
    );
    return {
      status: 'awaiting_human',
      awaitingHuman: true,
      failureAnalysisPending: false,
      failureAnalysisUsed: true,
      lastError: `missing_resource_awaiting_user:${missing.kind}:${missing.name}`,
    };
  }

  if (analysis.decision === 'escalate_human') {
    await notifyUser(
      runCtx(state),
      `🙋 ${analysis.operatorMessage}\n\n${humanizeOperatorError(state.lastError)}`
    );
    return {
      status: 'escalated',
      failureAnalysisPending: false,
      failureAnalysisUsed: true,
      lastError: analysis.reasoning,
    };
  }

  if (analysis.decision === 'stop_noop') {
    await notifyUser(runCtx(state), analysis.operatorMessage);
    return {
      status: 'failed',
      failureAnalysisPending: false,
      failureAnalysisUsed: true,
      lastError: analysis.reasoning,
    };
  }

  let request: StartRunRequest = patchRequestFromFailureAnalysis(state.request, analysis);
  const ctx: DiagnosisContext = {
    ...state.factsSanitized,
    priorActionSummary: `${describeDeployFailureForPlanner(state.lastError)} | analyst: ${analysis.reasoning}`,
    githubRepo: request.githubRepo ?? state.factsSanitized.githubRepo,
    mode: state.mode,
    incidentId: state.incidentId,
    namespace: state.namespace,
    resourceName: state.resourceName,
    resourceKind: state.resourceKind,
    triggeredBy: state.request.triggeredBy,
    triggeredAt: state.request.triggeredAt,
  };

  let plan: RemediationPlan;
  if (state.mode === 'pre-deploy') {
    plan = await buildDeployPlan(ctx, request);
    plan = mergeFailureAnalysisIntoPlan(plan, analysis) ?? plan;
  } else {
    const merged = mergeFailureAnalysisIntoPlan(state.lastFailedPlan, analysis);
    plan = merged ?? (await callPlanLlm(ctx, state.actionHistory));
  }

  if (plan.action === 'escalate_human' || plan.action === 'noop') {
    await notifyUser(runCtx(state), analysis.operatorMessage);
    return {
      status: plan.action === 'escalate_human' ? 'escalated' : 'failed',
      failureAnalysisPending: false,
      failureAnalysisUsed: true,
      pendingPlan: plan,
    };
  }

  log('info', AGENT, 'Failure analyst recommends retry', {
    incidentId: state.incidentId,
    action: plan.action,
    gitRef: plan.gitRef,
    confidence: analysis.confidence,
  });

  if (state.mode === 'pre-deploy' && state.request.platform && state.request.channelId) {
    await sendDeployProgress(
      {
        incidentId: state.incidentId,
        platform: state.request.platform,
        channelId: state.request.channelId,
      },
      `Retrying: ${plan.action}${plan.gitRef ? ` on branch ${plan.gitRef}` : ''}.`
    );
  }

  return {
    request,
    pendingPlan: plan,
    failureAnalysisPending: false,
    failureAnalysisUsed: true,
  };
}

async function verifyNode(state: GraphState): Promise<Partial<GraphState>> {
  if (state.mode === 'ci-failure') {
    const history = [...state.actionHistory];
    const lastAction = history[history.length - 1];
    if (lastAction?.success) {
      await notifyUser(
        runCtx(state),
        `✅ CI step completed: ${lastAction.summary ?? state.pendingPlan?.action ?? 'done'}`
      );
      return { status: 'succeeded', actionHistory: history };
    }
    if (lastAction && !lastAction.success) {
      return { status: 'failed', actionHistory: history, lastError: lastAction.summary };
    }
    return { status: 'succeeded', actionHistory: history };
  }

  const stored = await getRun(state.runId);
  const fromTranscript = stored?.transcript
    .filter((t) => t.tool === 'investigator.verify_health')
    .pop();

  const history = [...state.actionHistory];
  const lastAction = history[history.length - 1];
  const needsRolloutWait =
    !!lastAction?.success && actionNeedsRolloutWait(lastAction.action);

  const verify =
    !needsRolloutWait && fromTranscript !== undefined
      ? { healthy: fromTranscript.success, message: fromTranscript.summary ?? fromTranscript.error ?? '' }
      : await verifyAfterRemediation(state.namespace, state.resourceName, state.incidentId, {
          waitForRollout: needsRolloutWait,
          remediationAction: lastAction?.action,
          afterImagePatch:
            lastAction?.action === 'git_patch' &&
            planHasImagePatch(state.pendingPlan ?? stored?.metadata?.remediationPlan as RemediationPlan | undefined),
          onProgress:
            state.request.platform && state.request.channelId
              ? (msg) => notifyUser(runCtx(state), msg)
              : undefined,
        });

  if (history.length > 0 && lastAction) {
    history[history.length - 1] = {
      ...lastAction,
      verifyStatus: verify.healthy ? 'healthy' : 'degraded',
    };
  }

  const deployNotify =
    state.request.platform && state.request.channelId
      ? {
          incidentId: state.incidentId,
          platform: state.request.platform,
          channelId: state.request.channelId,
        }
      : undefined;

  if (verify.healthy) {
    if (state.mode === 'pre-deploy' && deployNotify) {
      await sendDeployProgress(
        deployNotify,
        deployReadySuccessMessage(state.resourceName, state.namespace, verify)
      );
    } else {
      await notifyUser(
        runCtx(state),
        `Deploy succeeded.\nApp: ${state.resourceName}\nNamespace: ${state.namespace}\noc get pods -n ${state.namespace}`
      );
    }
    return { status: 'succeeded', actionHistory: history };
  }

  // Pre-deploy: single pass — do not loop observe→plan→act (hits LangGraph recursionLimit).
  if (state.mode === 'pre-deploy') {
    const actOk = lastAction?.success === true;
    const msg = verify.message || 'Workload not healthy after deploy';
    if (actOk) {
      if (!state.postDeployRecoveryUsed) {
        const recovery = decidePostDeployRecovery(msg, state.resourceName);
        if (recovery.plan && recovery.status !== 'none') {
          if (deployNotify) {
            await sendDeployProgress(deployNotify, recovery.userMessage);
          }
          return {
            actionHistory: history,
            pendingPlan: recovery.plan,
            postDeployRecoveryUsed: true,
            authorizeForceHil: recovery.status === 'ask_confirmation',
            lastError: msg,
          };
        }
      }
      if (deployNotify) {
        watchDeployReadinessAndNotify({
          target: deployNotify,
          namespace: state.namespace,
          resourceName: state.resourceName,
          sendPromise: false,
        });
      }
      return { status: 'succeeded', actionHistory: history };
    }
    await notifyUser(
      runCtx(state),
      `❌ Deploy did not complete for ${state.resourceName} in ${state.namespace}.\n` +
        `${humanizeOperatorError(msg)}\n` +
        `No workloads were created — oc get pods -n ${state.namespace} will be empty.`
    );
    return { status: 'failed', actionHistory: history, lastError: msg };
  }

  if (state.mode === 'diagnose' && !verify.healthy) {
    const lastAction = history[history.length - 1];
    if (shouldHoldForOperator(verify)) {
      await notifyUser(
        runCtx(state),
        `⏳ **${state.resourceName}** is still coming up after the approved fix:\n` +
          `${verify.waitDetail ?? verify.message ?? 'Rollout in progress'}\n\n` +
          `I am **not** proposing another change while pods are still pulling/starting. ` +
          `Reply when you want me to re-check, or suggest a different fix if this takes too long.`
      );
      return {
        actionHistory: history,
        status: 'awaiting_human',
        awaitingHuman: true,
        lastError: verify.message,
      };
    }
    if (lastAction?.success && !state.postDeployRecoveryUsed && !verify.rolloutInProgress) {
      const recovery = decideDiagnoseVerifyRecovery(
        verify.message ?? '',
        state.resourceName,
        lastAction.action
      );
      if (recovery.status === 'ask_confirmation') {
        await notifyUser(runCtx(state), recovery.userMessage);
        return {
          actionHistory: history,
          status: 'awaiting_human',
          awaitingHuman: true,
          postDeployRecoveryUsed: true,
          lastError: verify.message,
        };
      }
    }
  }

  if (state.iteration >= state.maxIterations) {
    await notifyUser(runCtx(state), `⚠️ Escalated after ${state.iteration} iterations`);
    return { status: 'escalated', actionHistory: history, lastError: verify.message };
  }

  if (!verify.healthy && shouldHoldForOperator(verify)) {
    await notifyUser(
      runCtx(state),
      `⏳ Still waiting on cluster: ${verify.waitDetail ?? verify.message ?? 'rollout in progress'}`
    );
    return {
      actionHistory: history,
      status: 'awaiting_human',
      awaitingHuman: true,
      lastError: verify.message,
    };
  }

  const reflectPatch = await applyAgentReflect(
    { ...state, actionHistory: history },
    verify,
    agentNotify(state)
  );
  if (reflectPatch.status === 'succeeded') {
    return { ...reflectPatch, actionHistory: history };
  }
  if (reflectPatch.status === 'escalated' || reflectPatch.status === 'failed') {
    return { ...reflectPatch, actionHistory: history };
  }
  if (Object.keys(reflectPatch).length > 0) {
    return { ...reflectPatch, actionHistory: history, pendingPlan: undefined };
  }

  return { actionHistory: history, pendingPlan: undefined };
}

function routeAfterSanitize(state: GraphState): string {
  if (state.status === 'escalated' || state.status === 'failed') return END;
  if (state.mode === 'diagnose' && ragGroundingEnabled()) return 'ragGrounding';
  if (state.mode === 'diagnose') return 'provenanceGate';
  if (
    state.mode === 'pre-deploy' &&
    shouldRunSourceBuild({
      mode: state.mode,
      needsImageBuild: state.factsSanitized?.repoSignals?.needsImageBuild,
      buildStrategy: state.factsSanitized?.repoSignals?.buildStrategy,
      suggestedImage: state.factsSanitized?.repoSignals?.suggestedImage,
    })
  ) {
    return 'sourceBuild';
  }
  return 'plan';
}

function routeAfterSourceBuild(state: GraphState): string {
  if (
    state.status === 'awaiting_human' ||
    state.status === 'failed' ||
    state.status === 'escalated'
  ) {
    return END;
  }
  return 'plan';
}

function routeAfterRagGrounding(state: GraphState): string {
  if (state.status === 'escalated' || state.status === 'failed' || state.status === 'awaiting_human') {
    return END;
  }
  if (state.mode === 'diagnose') return 'provenanceGate';
  return 'plan';
}

function routeAfterProvenanceGate(state: GraphState): string {
  if (state.status === 'awaiting_human' || state.status === 'failed' || state.status === 'escalated') {
    return END;
  }
  return 'plan';
}

async function provenanceGateGraphNode(state: GraphState): Promise<Partial<GraphState>> {
  return provenanceGateNode(state);
}

function routeAfterPreflight(state: GraphState): string {
  if (state.status === 'escalated' || state.status === 'failed') return END;
  return 'authorize';
}

function routeAfterPolicy(state: GraphState): string {
  if (state.status === 'awaiting_human' || state.status === 'failed' || state.status === 'escalated') return END;
  return 'act';
}

function routeAfterAct(state: GraphState): string {
  if (
    state.status === 'awaiting_human' ||
    state.status === 'failed' ||
    state.status === 'escalated' ||
    state.status === 'succeeded'
  ) {
    return END;
  }
  if (state.failureAnalysisPending) return 'analyzeFailure';
  return 'verify';
}

function routeAfterAnalyzeFailure(state: GraphState): string {
  if (state.status === 'failed' || state.status === 'escalated') return END;
  if (state.pendingPlan) return 'authorize';
  return END;
}

function routeAfterVerify(state: GraphState): string {
  if (state.status === 'succeeded' || state.status === 'escalated' || state.status === 'failed') {
    return END;
  }
  if (state.mode === 'ci-failure') {
    return END;
  }
  if (state.mode === 'pre-deploy') {
    if (state.pendingPlan) return 'authorize';
    return END;
  }
  if (isAgenticDiagnose(state.request, state.mode)) {
    return 'agentDecide';
  }
  return 'observe';
}

function routeAtStart(state: GraphState): string {
  if (isAgenticDiagnose(state.request, state.mode)) {
    return 'agentDecide';
  }
  return 'observe';
}

function routeAfterAgentDecide(state: GraphState): string {
  if (state.status === 'escalated' || state.status === 'failed') {
    return END;
  }
  if (state.agentInvestigateComplete) {
    return 'agentFinalize';
  }
  if (state.pendingReadTool?.name) {
    return 'agentRead';
  }
  return END;
}

const checkpointer = new MemorySaver();

export function buildGraph() {
  return new StateGraph(RunAnnotation)
    .addNode('observe', observeNode)
    .addNode('agentDecide', agentDecideGraphNode)
    .addNode('agentRead', agentReadGraphNode)
    .addNode('agentFinalize', agentFinalizeGraphNode)
    .addNode('sanitize', sanitizeNode)
    .addNode('ragGrounding', ragGroundingNode)
    .addNode('provenanceGate', provenanceGateGraphNode)
    .addNode('sourceBuild', sourceBuildNode)
    .addNode('plan', planNode)
    .addNode('preflight', preflightNode)
    .addNode('authorize', authorizeNode)
    .addNode('policy', policyNode)
    .addNode('act', actNode)
    .addNode('analyzeFailure', analyzeFailureNode)
    .addNode('verify', verifyNode)
    .addConditionalEdges(START, routeAtStart, {
      observe: 'observe',
      agentDecide: 'agentDecide',
    })
    .addEdge('observe', 'sanitize')
    .addConditionalEdges('agentDecide', routeAfterAgentDecide, {
      agentRead: 'agentRead',
      agentFinalize: 'agentFinalize',
      [END]: END,
    })
    .addEdge('agentRead', 'agentDecide')
    .addEdge('agentFinalize', 'sanitize')
    .addConditionalEdges('sanitize', routeAfterSanitize, {
      ragGrounding: 'ragGrounding',
      provenanceGate: 'provenanceGate',
      sourceBuild: 'sourceBuild',
      plan: 'plan',
      [END]: END,
    })
    .addConditionalEdges('sourceBuild', routeAfterSourceBuild, {
      plan: 'plan',
      [END]: END,
    })
    .addConditionalEdges('ragGrounding', routeAfterRagGrounding, {
      provenanceGate: 'provenanceGate',
      plan: 'plan',
      [END]: END,
    })
    .addConditionalEdges('provenanceGate', routeAfterProvenanceGate, { plan: 'plan', [END]: END })
    .addEdge('plan', 'preflight')
    .addConditionalEdges('preflight', routeAfterPreflight, { authorize: 'authorize', [END]: END })
    .addEdge('authorize', 'policy')
    .addConditionalEdges('policy', routeAfterPolicy, { act: 'act', [END]: END })
    .addConditionalEdges('act', routeAfterAct, {
      analyzeFailure: 'analyzeFailure',
      verify: 'verify',
      [END]: END,
    })
    .addConditionalEdges('analyzeFailure', routeAfterAnalyzeFailure, {
      authorize: 'authorize',
      [END]: END,
    })
    .addConditionalEdges('verify', routeAfterVerify, {
      authorize: 'authorize',
      observe: 'observe',
      agentDecide: 'agentDecide',
      [END]: END,
    })
    .compile({
      checkpointer,
    });
}

function graphRecursionLimit(): number {
  return Math.max(
    50,
    MAX_ITERATIONS * 10 + 10,
    parseInt(process.env['AGENTIC_MAX_TURNS'] ?? '12', 10) * 3 + 20
  );
}

export async function startRun(
  request: StartRunRequest
): Promise<{ runId: string; status: RunStatus; lastError?: string }> {
  const runId = uuidv4();
  const initial: GraphState = {
    runId,
    incidentId: request.incidentId,
    request,
    mode: request.mode,
    namespace: request.namespace,
    resourceName: request.resourceName,
    resourceKind: request.resourceKind,
    factsRaw: undefined,
    factsSanitized: undefined,
    securityFindings: [],
    actionHistory: [],
    iteration: 0,
    maxIterations: MAX_ITERATIONS,
    pendingPlan: undefined,
    authorizeForceHil: false,
    autonomyMode: getAutonomyMode(),
    status: 'running',
    awaitingHuman: false,
    lastError: undefined,
    failureAnalysisPending: false,
    failureAnalysisUsed: false,
    lastFailedPlan: undefined,
    postDeployRecoveryUsed: false,
    preflightAttempts: 0,
    stackDeployPlan: undefined,
    agentEvidence: undefined,
    agentSteps: [],
    agentFetchedTools: [],
    agentTurns: 0,
    pendingReadTool: undefined,
    agentGoal: undefined,
    agentFocusGoal: undefined,
    agentInvestigateComplete: false,
    retrievedPlaybook: undefined,
    detectedErrorSignature: undefined,
    targetComponent: undefined,
  };

  log('info', AGENT, 'Starting run', {
    runId,
    incidentId: request.incidentId,
    agentMode: resolveRunAgentMode(request).agentMode,
    caseId: request.caseId,
  });
  await initRun(runId, request.incidentId, { mode: request.mode, request });

  if (await isRunRequestIgnored(request)) {
    await setRunStatus(runId, 'cancelled');
    log('info', AGENT, 'Run skipped — resource on ignore list', {
      runId,
      incidentId: request.incidentId,
      namespace: request.namespace,
      resourceName: request.resourceName,
    });
    return { runId, status: 'cancelled', lastError: 'Resource is ignored' };
  }

  const compiled = buildGraph();
  const final = await compiled.invoke(initial, {
    configurable: { thread_id: runId },
    recursionLimit: graphRecursionLimit(),
  });
  const status = final.status as RunStatus;
  const lastError = final.lastError as string | undefined;
  await setRunStatus(runId, status);
  await snapshotRunOutcome(runId, final as GraphState);

  await notifyRunOutcome(
    {
      ...initial,
      ...(final as GraphState),
      runId,
      status,
      lastError,
      pendingPlan: (final as GraphState).pendingPlan ?? initial.pendingPlan,
    },
    (final as GraphState).actionHistory ?? []
  );

  return { runId, status, lastError };
}

async function notifyRunOutcome(
  state: GraphState & { runId: string },
  actionHistory: ActionRecord[]
): Promise<void> {
  if (!state.request.platform || !state.request.channelId) return;

  const ctx = runCtx(state);
  const modeLabel = modeOutcomeLabel(state.mode);

  if (state.status === 'awaiting_human') {
    // policyNode already pushed hil_required / ci_approval_* to chat before pausing.
    return;
  }

  if (state.status === 'failed') {
    const detail = state.lastError ?? 'Unknown error';
    if (/Could not clone|Could not read the deploy repo/i.test(detail)) {
      return;
    }
    await notifyUserUpdate(ctx, {
      kind: 'run_failed',
      incidentId: state.incidentId,
      runId: state.runId,
      mode: state.mode,
      detailAvailable: true,
      technicalMessage: humanizeOperatorError(detail),
    });
    return;
  }

  if (state.status === 'succeeded' && state.mode !== 'pre-deploy') {
    const lastSuccessful = [...actionHistory].reverse().find((a) => a.success);
    const prMatch = lastSuccessful?.summary?.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
    await notifyUserUpdate(ctx, {
      kind: 'run_succeeded',
      incidentId: state.incidentId,
      runId: state.runId,
      mode: state.mode,
      detailAvailable: true,
      codingAgentPrUrl: prMatch?.[0],
      technicalMessage:
        `${modeLabel.charAt(0).toUpperCase() + modeLabel.slice(1)} ${runStatusOutcomeLabel('succeeded')}.` +
        (lastSuccessful?.summary ? `\n${lastSuccessful.summary.slice(0, 300)}` : ''),
    });
    return;
  }

  // Most escalate paths already sent a detailed notifyUser message (policyNode, failure analyst, etc.).
  if (state.status === 'escalated' && state.mode !== 'pre-deploy') {
    return;
  }

  // Pre-deploy success/failure summaries are sent from verify/confirm; avoid duplicate here.
}

async function resumeAfterSourceBuildApproval(
  cmd: import('../../../shared/src/types.js').RemediateCommand,
  existing: import('./run-store.js').StoredRun | undefined
): Promise<RunStatus> {
  const runId = cmd.runId ?? cmd.incidentId;
  const storedRequest = existing?.metadata?.request as StartRunRequest | undefined;
  const request: StartRunRequest = {
    ...(storedRequest ?? (cmd as unknown as StartRunRequest)),
    incidentId: cmd.incidentId,
    namespace: cmd.namespace,
    resourceName: cmd.resourceName,
    resourceKind: cmd.resourceKind,
    mode: cmd.mode,
    triggeredBy: cmd.triggeredBy,
    triggeredAt: cmd.triggeredAt,
    platform: cmd.platform ?? storedRequest?.platform,
    channelId: cmd.channelId ?? storedRequest?.channelId,
    requestedBy: cmd.requestedBy ?? storedRequest?.requestedBy,
  };

  const factsSnapshot = existing?.metadata?.factsSnapshot as DiagnosisContext | undefined;

  let state: GraphState = {
    runId,
    incidentId: cmd.incidentId,
    request,
    namespace: cmd.namespace,
    resourceName: cmd.resourceName,
    resourceKind: cmd.resourceKind,
    mode: cmd.mode,
    pendingPlan: undefined,
    actionHistory: [],
    iteration: Math.max(1, existing?.transcript?.length ?? 1),
    maxIterations: MAX_ITERATIONS,
    authorizeForceHil: false,
    autonomyMode: getAutonomyMode(),
    status: 'running',
    awaitingHuman: false,
    securityFindings: [],
    factsRaw: factsSnapshot,
    factsSanitized: factsSnapshot,
    lastError: undefined,
    failureAnalysisPending: false,
    failureAnalysisUsed: false,
    lastFailedPlan: undefined,
    postDeployRecoveryUsed: false,
    preflightAttempts: 0,
    stackDeployPlan: undefined,
    agentEvidence: undefined,
    agentSteps: [],
    agentFetchedTools: [],
    agentTurns: 0,
    pendingReadTool: undefined,
    agentGoal: undefined,
    agentFocusGoal: undefined,
    agentInvestigateComplete: false,
    retrievedPlaybook: undefined,
    detectedErrorSignature: undefined,
    targetComponent: undefined,
  };

  await setRunStatus(runId, 'running');
  await mergeRunMetadata(runId, { sourceBuildApproved: true });

  if (request.platform && request.channelId) {
    await notifyUser(
      runCtx(state),
      `▶️ Approved — building container image for \`${cmd.resourceName}\`…`
    );
  }

  const buildPatch = await continueAfterSourceBuildApproval(state);
  state = { ...state, ...buildPatch };
  if (state.status === 'failed' || state.status === 'awaiting_human') {
    await setRunStatus(runId, state.status);
    await snapshotRunOutcome(runId, state);
    await notifyRunOutcome({ ...state, runId, status: state.status }, state.actionHistory ?? []);
    return state.status;
  }

  state = { ...state, ...(await planNode(state)) };
  state = { ...state, ...(await preflightNode(state)) };
  if (state.status === 'failed' || state.status === 'escalated') {
    await setRunStatus(runId, state.status);
    await snapshotRunOutcome(runId, state, 'approved');
    await notifyRunOutcome({ ...state, runId, status: state.status }, state.actionHistory ?? []);
    return state.status;
  }

  state = { ...state, ...(await authorizeNode(state)) };
  if (state.status === 'escalated') {
    await setRunStatus(runId, 'escalated');
    await snapshotRunOutcome(runId, state, 'approved');
    await notifyRunOutcome({ ...state, runId, status: 'escalated' }, state.actionHistory ?? []);
    return 'escalated';
  }

  state = { ...state, ...(await policyNode(state)) };
  if (state.status === 'awaiting_human') {
    await snapshotRunOutcome(runId, state, 'approved');
    await notifyRunOutcome({ ...state, runId, status: 'awaiting_human' }, state.actionHistory ?? []);
    return 'awaiting_human';
  }
  if (state.status === 'failed' || state.status === 'escalated') {
    await setRunStatus(runId, state.status);
    await snapshotRunOutcome(runId, state, 'approved');
    await notifyRunOutcome({ ...state, runId, status: state.status }, state.actionHistory ?? []);
    return state.status;
  }

  state = { ...state, ...(await actNode(state)) };
  const verifyResult = await verifyNode(state);
  const finalState = { ...state, ...verifyResult } as GraphState;
  const status = (finalState.status ?? 'failed') as RunStatus;

  await setRunStatus(runId, status);
  await snapshotRunOutcome(runId, finalState, 'approved');
  await notifyRunOutcome({ ...finalState, runId, status }, finalState.actionHistory ?? []);
  return status;
}

export async function resumeRunAfterApproval(cmd: RemediateCommand): Promise<RunStatus> {
  const runId = cmd.runId ?? cmd.incidentId;
  const existing = await getRun(runId);
  if (!existing) {
    await initRun(runId, cmd.incidentId, { request: cmd });
  }

  const meta = existing?.metadata ?? {};
  const sourceBuildPending = meta['sourceBuildPending'] as
    | import('../../../shared/src/deploy/source-build-gate.js').SourceBuildPending
    | undefined;
  const sourceBuildDone =
    typeof meta['sourceBuildResult'] === 'object' &&
    (meta['sourceBuildResult'] as { success?: boolean }).success === true;

  if (sourceBuildPending && !sourceBuildDone) {
    return resumeAfterSourceBuildApproval(cmd, existing);
  }

  const storedRequest = existing?.metadata?.request as StartRunRequest | undefined;
  const request: StartRunRequest = {
    ...(storedRequest ?? (cmd as unknown as StartRunRequest)),
    incidentId: cmd.incidentId,
    namespace: cmd.namespace,
    resourceName: cmd.resourceName,
    resourceKind: cmd.resourceKind,
    mode: cmd.mode,
    triggeredBy: cmd.triggeredBy,
    triggeredAt: cmd.triggeredAt,
    platform: cmd.platform ?? storedRequest?.platform,
    channelId: cmd.channelId ?? storedRequest?.channelId,
    requestedBy: cmd.requestedBy ?? storedRequest?.requestedBy,
  };

  const storedPlan =
    (existing?.metadata?.remediationPlan as RemediationPlan | undefined) ?? cmd.plan;

  let state: GraphState = {
    runId,
    incidentId: cmd.incidentId,
    request,
    namespace: cmd.namespace,
    resourceName: cmd.resourceName,
    resourceKind: cmd.resourceKind,
    mode: cmd.mode,
    pendingPlan: cmd.plan ?? storedPlan,
    actionHistory: [],
    iteration: Math.max(1, existing?.transcript?.length ?? 1),
    maxIterations: MAX_ITERATIONS,
    authorizeForceHil: false,
    autonomyMode: getAutonomyMode(),
    status: 'running',
    awaitingHuman: false,
    securityFindings: [],
    factsRaw: undefined,
    factsSanitized: undefined,
    lastError: undefined,
    failureAnalysisPending: false,
    failureAnalysisUsed: false,
    lastFailedPlan: undefined,
    postDeployRecoveryUsed: false,
    preflightAttempts: 0,
    stackDeployPlan: undefined,
    agentEvidence: undefined,
    agentSteps: [],
    agentFetchedTools: [],
    agentTurns: 0,
    pendingReadTool: undefined,
    agentGoal: undefined,
    agentFocusGoal: undefined,
    agentInvestigateComplete: false,
    retrievedPlaybook: undefined,
    detectedErrorSignature: undefined,
    targetComponent: undefined,
  };

  await setRunStatus(runId, 'running');

  if (request.platform && request.channelId) {
    await notifyUser(
      runCtx(state),
      `▶️ Approved — applying ${cmd.plan.action} for \`${cmd.resourceName}\` in \`${cmd.namespace}\`…`
    );
  }

  let merged = { ...state, ...(await actNode(state)) } as GraphState;

  if (
    merged.pendingPlan &&
    merged.authorizeForceHil &&
    merged.status !== 'awaiting_human' &&
    merged.status !== 'succeeded'
  ) {
    const lastAct = merged.actionHistory[merged.actionHistory.length - 1];
    if (lastAct && !lastAct.success) {
      await requestHilApproval(
        runCtx(merged),
        merged.pendingPlan,
        merged.iteration,
        merged.maxIterations
      );
      await setRunStatus(runId, 'awaiting_human');
      await snapshotRunOutcome(runId, { ...merged, status: 'awaiting_human' }, 'pending');
      await notifyRunOutcome(
        { ...merged, runId, status: 'awaiting_human' },
        merged.actionHistory ?? []
      );
      return 'awaiting_human';
    }
  }

  const firstAct = merged.actionHistory[merged.actionHistory.length - 1];
  if (firstAct && !firstAct.success && request.platform && request.channelId) {
    await notifyUser(
      runCtx(merged),
      `❌ Fix failed to apply on cluster:\n${humanizeOperatorError(merged.lastError ?? firstAct.summary)}`
    );
  }

  if (merged.failureAnalysisPending && !merged.failureAnalysisUsed) {
    if (!merged.factsSanitized) {
      try {
        const facts = await gatherFacts(merged.request);
        const sanitized = await sanitizeFacts(facts);
        merged = { ...merged, factsRaw: facts, factsSanitized: sanitized };
      } catch (err) {
        log('warn', AGENT, 'Could not refresh facts during resume failure analysis', {
          incidentId: merged.incidentId,
          error: String(err),
        });
      }
    }
    const analysisResult = await analyzeFailureNode(merged);
    merged = { ...merged, ...analysisResult } as GraphState;
    if (
      merged.pendingPlan &&
      merged.status !== 'failed' &&
      merged.status !== 'escalated' &&
      merged.status !== 'awaiting_human'
    ) {
      merged = {
        ...merged,
        status: 'running',
        ...(await actNode({ ...merged, pendingPlan: merged.pendingPlan })),
      } as GraphState;
    }
  }

  const lastAct = merged.actionHistory[merged.actionHistory.length - 1];
  if (lastAct && !lastAct.success && merged.status !== 'awaiting_human') {
    merged = {
      ...merged,
      status: 'failed',
      lastError: merged.lastError ?? lastAct.summary,
    };
  }
  if (merged.status === 'awaiting_human') {
    await setRunStatus(runId, 'awaiting_human');
    await snapshotRunOutcome(runId, merged, 'approved');
    await notifyRunOutcome({ ...merged, runId, status: 'awaiting_human' }, merged.actionHistory ?? []);
    return 'awaiting_human';
  }
  if (merged.status === 'succeeded') {
    await setRunStatus(runId, 'succeeded');
    await snapshotRunOutcome(runId, merged, 'approved');
    await notifyRunOutcome({ ...merged, runId, status: 'succeeded' }, merged.actionHistory ?? []);
    return 'succeeded';
  }
  const verifyResult = await verifyNode(merged);
  let finalState = { ...merged, ...verifyResult } as GraphState;
  let status = finalState.status as RunStatus | undefined;

  if (status === undefined || status === 'running') {
    if (finalState.pendingPlan) {
      await requestHilApproval(runCtx(finalState), finalState.pendingPlan, finalState.iteration, finalState.maxIterations);
      status = 'awaiting_human';
      finalState = { ...finalState, status, awaitingHuman: true };
    } else {
      status = 'failed';
      finalState = {
        ...finalState,
        status,
        lastError:
          finalState.lastError ??
          'Approved remediation executed but did not reach a terminal outcome.',
      };
    }
  }

  await setRunStatus(runId, status);
  await snapshotRunOutcome(runId, finalState, 'approved');
  await notifyRunOutcome({ ...finalState, runId, status }, finalState.actionHistory ?? []);
  return status;
}

export { actNode, verifyNode };

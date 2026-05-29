/**
 * LLM failure analyst — decides whether to retry (with plan changes) or escalate.
 * Does NOT execute cluster commands; orchestrator runs authorize → act.
 */

import { GoogleGenAI, Type } from '@google/genai';
import type {
  FailureAnalysisRequest,
  FailureAnalysisResult,
  FailureDecision,
  RemediationAction,
} from '../../../shared/src/types.js';
import { deterministicFailureAnalysis } from '../../../shared/src/failure-analysis-fallback.js';
import { log } from '../../../shared/src/http.js';
import { resolveBrainLlm } from '../../../shared/src/llm-config.js';
import { openRouterChat, stripJsonFences } from '../../../shared/src/openrouter.js';

const AGENT = 'brain-failure-analyst';
const GEMINI_API_KEY = process.env['GEMINI_API_KEY'];
const genai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

const failureAnalysisSchema = {
  type: Type.OBJECT,
  required: ['decision', 'reasoning', 'operatorMessage', 'confidence'],
  properties: {
    decision: {
      type: Type.STRING,
      enum: ['retry_with_plan', 'escalate_human', 'stop_noop'],
    },
    reasoning: { type: Type.STRING },
    operatorMessage: {
      type: Type.STRING,
      description: 'One or two short sentences for Telegram, plain English.',
    },
    confidence: { type: Type.NUMBER },
    suggestedAction: {
      type: Type.STRING,
      enum: ['restart', 'git_patch', 'helm_deploy', 'repo_apply', 'escalate_human', 'noop'],
    },
    suggestedGitRef: { type: Type.STRING },
    deployStrategy: { type: Type.STRING, enum: ['gitops', 'direct'] },
    rootCause: { type: Type.STRING },
    missingResource: {
      type: Type.OBJECT,
      required: ['kind', 'name', 'reason', 'canAutoCreate'],
      properties: {
        kind: {
          type: Type.STRING,
          enum: ['namespace', 'configmap', 'secret', 'serviceaccount', 'crd', 'other'],
        },
        name: { type: Type.STRING },
        namespace: { type: Type.STRING },
        reason: { type: Type.STRING },
        canAutoCreate: { type: Type.BOOLEAN },
        createAction: {
          type: Type.STRING,
          enum: ['create_namespace'],
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are an SRE failure analyst. A remediation action already FAILED.
Your job is to decide the ONE best next step — not to list every possible command.

Rules:
- If failureKind is cluster_unreachable OR alternateStrategyMayHelp is false: do NOT suggest trying Helm because kubectl failed (or vice versa). Same API connection.
- If the failure is due to a missing resource (especially namespace), set missingResource with a clear reason.
- For TLS/x509/certificate errors: decision should be escalate_human unless the only fix is a different git branch.
- For missing git branch: retry_with_plan with suggestedGitRef (e.g. develop, master) if plausible.
- For RBAC/auth errors: escalate_human.
- For transient pod issues in diagnose mode: retry_with_plan with action restart if not already tried.
- operatorMessage must be friendly and specific (no stack traces).
- confidence 0.0-1.0`;

function buildUserPrompt(req: FailureAnalysisRequest): string {
  return JSON.stringify(
    {
      mode: req.mode,
      namespace: req.namespace,
      resourceName: req.resourceName,
      failedAction: req.failedAction,
      failureKind: req.failureKind,
      alternateStrategyMayHelp: req.alternateStrategyMayHelp,
      errorMessage: req.errorMessage.slice(0, 2000),
      actionHistorySummary: req.actionHistorySummary,
      githubRepo: req.githubRepo,
      gitRef: req.gitRef,
      deployStrategy: req.deployStrategy,
      repoFacts: {
        needsHelmGeneration: req.facts.needsHelmGeneration,
        repoEntryPointKind: req.facts.repoEntryPointKind,
        gitManifestPath: req.facts.gitManifestPath,
        resolvedGitRef: req.facts.resolvedGitRef,
        priorActionSummary: req.facts.priorActionSummary,
      },
    },
    null,
    2
  );
}

function validateAnalysis(obj: unknown): FailureAnalysisResult {
  if (typeof obj !== 'object' || obj === null) throw new Error('Not an object');
  const o = obj as Record<string, unknown>;
  const decisions: FailureDecision[] = ['retry_with_plan', 'escalate_human', 'stop_noop'];
  if (!decisions.includes(o['decision'] as FailureDecision)) {
    throw new Error(`Invalid decision: ${o['decision']}`);
  }
  const confidence = Number(o['confidence']);
  if (Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('confidence must be 0-1');
  }
  const actions: RemediationAction[] = [
    'restart',
    'git_patch',
    'helm_deploy',
    'repo_apply',
    'escalate_human',
    'noop',
  ];
  let suggestedAction = o['suggestedAction'] as RemediationAction | undefined;
  if (suggestedAction && !actions.includes(suggestedAction)) {
    suggestedAction = undefined;
  }
  return {
    decision: o['decision'] as FailureDecision,
    reasoning: String(o['reasoning'] ?? '').slice(0, 2000),
    operatorMessage: String(o['operatorMessage'] ?? o['reasoning'] ?? 'Analyzing failure…').slice(
      0,
      500
    ),
    confidence,
    suggestedAction,
    suggestedGitRef: o['suggestedGitRef'] ? String(o['suggestedGitRef']) : undefined,
    deployStrategy:
      o['deployStrategy'] === 'gitops' || o['deployStrategy'] === 'direct'
        ? o['deployStrategy']
        : undefined,
    rootCause: o['rootCause'] ? String(o['rootCause']) : undefined,
    missingResource: normalizeMissingResource(o['missingResource']),
  };
}

function normalizeMissingResource(
  raw: unknown
): FailureAnalysisResult['missingResource'] | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  const kinds = ['namespace', 'configmap', 'secret', 'serviceaccount', 'crd', 'other'] as const;
  const kind = kinds.find((k) => k === m['kind']);
  const name = typeof m['name'] === 'string' ? m['name'].trim() : '';
  const reason = typeof m['reason'] === 'string' ? m['reason'].trim() : '';
  if (!kind || !name || !reason) return undefined;
  return {
    kind,
    name,
    namespace: typeof m['namespace'] === 'string' ? m['namespace'] : undefined,
    reason,
    canAutoCreate: Boolean(m['canAutoCreate']),
    createAction: m['createAction'] === 'create_namespace' ? 'create_namespace' : undefined,
  };
}

export async function analyzeFailure(req: FailureAnalysisRequest): Promise<FailureAnalysisResult> {
  let llm: ReturnType<typeof resolveBrainLlm>;
  try {
    llm = resolveBrainLlm();
  } catch {
    log('warn', AGENT, 'LLM not configured — deterministic failure analysis', {
      incidentId: req.incidentId,
    });
    return deterministicFailureAnalysis(
      {
        kind: req.failureKind as import('../../../shared/src/deploy-failure.js').DeployFailureKind,
        summary: req.errorMessage.slice(0, 200),
        alternateStrategyMayHelp: req.alternateStrategyMayHelp,
        autoRemediations: [],
      },
      req.errorMessage
    );
  }

  const userPrompt = buildUserPrompt(req);
  let rawText = '';

  try {
    if (llm.backend === 'openrouter') {
      rawText = await openRouterChat({
        model: llm.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        jsonMode: true,
        temperature: 0.1,
        callerAgent: AGENT,
        incidentId: req.incidentId,
      });
    } else if (genai) {
      const response = await genai.models.generateContent({
        model: llm.model,
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: 'application/json',
          responseSchema: failureAnalysisSchema,
          temperature: 0.1,
        },
      });
      rawText = response.text ?? '';
    } else {
      throw new Error('No LLM backend');
    }

    const parsed = JSON.parse(stripJsonFences(rawText));
    const result = validateAnalysis(parsed);

    if (
      req.failureKind === 'cluster_unreachable' &&
      result.decision === 'retry_with_plan' &&
      result.suggestedAction &&
      ['helm_deploy', 'repo_apply'].includes(result.suggestedAction) &&
      !result.suggestedGitRef
    ) {
      log('warn', AGENT, 'LLM suggested retry despite cluster_unreachable — overriding to escalate', {
        incidentId: req.incidentId,
      });
      return deterministicFailureAnalysis(
        {
          kind: 'cluster_unreachable',
          summary: req.errorMessage.slice(0, 200),
          alternateStrategyMayHelp: false,
          autoRemediations: ['kubeconfig_insecure_tls'],
        },
        req.errorMessage
      );
    }

    log('info', AGENT, 'Failure analysis complete', {
      incidentId: req.incidentId,
      decision: result.decision,
      confidence: result.confidence,
    });
    return result;
  } catch (err) {
    log('warn', AGENT, 'LLM failure analysis failed — using deterministic fallback', {
      incidentId: req.incidentId,
      error: String(err).slice(0, 300),
    });
    return deterministicFailureAnalysis(
      {
        kind: req.failureKind as import('../../../shared/src/deploy-failure.js').DeployFailureKind,
        summary: req.errorMessage.slice(0, 200),
        alternateStrategyMayHelp: req.alternateStrategyMayHelp,
        autoRemediations: [],
      },
      req.errorMessage
    );
  }
}

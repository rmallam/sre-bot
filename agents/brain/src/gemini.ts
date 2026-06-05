/**
 * gemini.ts
 *
 * Calls the Gemini API or OpenRouter API with a strict JSON Schema response format
 * to eliminate hallucination risk and ensure the output always conforms to RemediationPlan.
 *
 * Provider selection: shared/llm-config (OpenRouter-first by default).
 * Native Gemini uses strict responseSchema; OpenRouter uses JSON mode + validation.
 */

import { GoogleGenAI, Type } from '@google/genai';
import type { DiagnosisContext, RemediationPlan } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import { resolveBrainLlm } from '../../../shared/src/llm-config.js';
import { openRouterChat, stripJsonFences } from '../../../shared/src/openrouter.js';
import { skillsSystemAppendix } from '../../../shared/src/skills-loader.js';

const AGENT = 'brain-agent';

const GEMINI_API_KEY = process.env['GEMINI_API_KEY'];
const genai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

try {
  resolveBrainLlm();
} catch (err) {
  log('error', AGENT, 'LLM not configured at startup', { error: String(err) });
}

// ── Response Schema ───────────────────────────────────────────────────────────
// Mirrors the RemediationPlan interface exactly.

const remediationPlanSchema = {
  type: Type.OBJECT,
  required: [
    'action',
    'rootCause',
    'reasoning',
    'severity',
    'proposedPatch',
    'targetManifestPath',
    'commitMessage',
    'rollbackSafe',
  ],
  properties: {
    action: {
      type: Type.STRING,
      enum: ['restart', 'git_patch', 'helm_deploy', 'repo_apply', 'escalate_human', 'noop'],
      description: 'Remediation action to take. Prefer restart for transient issues unless restart_failed in priorActionSummary.',
    },
    rootCause: {
      type: Type.STRING,
      description: 'The root cause of the incident in one or two sentences.',
    },
    reasoning: {
      type: Type.STRING,
      description:
        'Step-by-step reasoning that led to the diagnosis, citing only the facts provided.',
    },
    severity: {
      type: Type.STRING,
      enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
      description: 'Severity classification of the incident.',
    },
    proposedPatch: {
      type: Type.ARRAY,
      description: 'RFC 6902 JSON Patch operations to fix the issue.',
      items: {
        type: Type.OBJECT,
        required: ['op', 'path'],
        properties: {
          op: {
            type: Type.STRING,
            enum: ['replace', 'add', 'remove', 'test'],
            description: 'JSON Patch operation type.',
          },
          path: {
            type: Type.STRING,
            description: 'JSON Pointer path within the Kubernetes manifest.',
          },
          value: {
            description: 'Value for add/replace operations. Omit for remove/test.',
          },
        },
      },
    },
    targetManifestPath: {
      type: Type.STRING,
      description:
        'Relative path to the Kubernetes manifest file inside the GitOps repository.',
    },
    commitMessage: {
      type: Type.STRING,
      description:
        'Conventional commit message, e.g. "fix(deployment): increase memory limit for oom-killed pod".',
    },
    rollbackSafe: {
      type: Type.BOOLEAN,
      description:
        'True if applying the patch and then reverting it is safe with no data-loss risk.',
    },
  },
};

// Helper to convert the GenAI Type enum values to standard lowercase string types for OpenRouter
function toStandardJsonSchema(schema: any): any {
  if (typeof schema !== 'object' || schema === null) return schema;
  const copy = { ...schema };
  if (typeof copy.type === 'string') {
    copy.type = copy.type.toLowerCase();
  }
  if (copy.properties) {
    const props: any = {};
    for (const key of Object.keys(copy.properties)) {
      props[key] = toStandardJsonSchema(copy.properties[key]);
    }
    copy.properties = props;
  }
  if (copy.items) {
    copy.items = toStandardJsonSchema(copy.items);
  }
  return copy;
}

const SYSTEM_PROMPT = `You are a Kubernetes SRE (Site Reliability Engineer) with deep expertise in diagnosing, remediating production incidents, and deploying new applications.

You will be given structured facts in JSON format. The "mode" field indicates the operation:
- "diagnose": Analyze the incident facts and produce a remediation plan.
- "pre-deploy": Onboard a new application or update an existing deployment.

STRICT RULES:
1. You MUST only use information provided in the facts. Do NOT make assumptions or guess values not present in the input.
2. Set "action" field explicitly:
   - "restart": transient failures (CrashLoopBackOff, probe failures) when priorActionSummary does NOT contain restart_failed
   - "git_patch": config fixes (OOM limits, image tags, resources) or after restart_failed
   - In "diagnose" mode: use git_patch ONLY when gitManifestContent is present OR patchTarget is cluster for live Deployment/StatefulSet image/resource fixes. If no manifest and no verified workload, set action to "escalate_human".
   - "helm_deploy": pre-deploy GitOps mode when needsHelmGeneration is true — include helmChart.files with Chart.yaml, values.yaml, templates/
   - "repo_apply": pre-deploy direct mode where manifests/charts should be applied from source repo without any Git push
   - "escalate_human": insufficient data or CRITICAL risk
   - "noop": nothing to do
3. In "diagnose" mode: If you cannot determine a root cause, set action to "escalate_human" and proposedPatch to [].
3b. In "diagnose" mode without gitManifestContent: prefer escalate_human over git_patch unless proposing a cluster hot-fix with a concrete proposedPatch on /spec/template/*.
4. In "pre-deploy" mode:
   - If needsHelmGeneration is true, set action to "helm_deploy" and populate helmChart.files
   - If gitManifestContent is provided, use action "git_patch"
   - If gitManifestContent is NOT provided, generate Deployment via git_patch (single "add" at path "")
5. Your proposedPatch MUST be valid RFC 6902 JSON Patch when action is git_patch.
6. targetManifestPath from gitManifestPath or deployments/<resourceName>.yaml (or deploy/helm/<resourceName> for helm)
7. commitMessage MUST follow Conventional Commits format.
8. Output JSON must include: action, rootCause, reasoning, severity, proposedPatch, targetManifestPath, commitMessage, rollbackSafe, and optionally helmChart, targetRepo.
9. When retrievedPlaybook is present in facts, align remediation with that official runbook; do not invent steps outside it unless action is escalate_human.
Do not add conversational text outside the JSON object.`;

function systemPrompt(ctx?: DiagnosisContext): Promise<string> {
  return skillsSystemAppendix({
    mode: ctx?.mode,
    namespace: ctx?.namespace,
    resourceName: ctx?.resourceName,
    errorSignature: ctx?.detectedErrorSignature,
    rootCause: ctx?.recentEvents?.[0]?.message,
    targetComponent: ctx?.targetComponent,
  }).then((appendix) => SYSTEM_PROMPT + appendix);
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildUserPrompt(ctx: DiagnosisContext): string {
  const facts = {
    incidentId: ctx.incidentId,
    mode: ctx.mode,
    namespace: ctx.namespace,
    resourceKind: ctx.resourceKind,
    resourceName: ctx.resourceName,
    podSpec: ctx.podSpec,
    containerStatuses: ctx.containerStatuses,
    resourceLimits: ctx.resourceLimits,
    nodeInfo: ctx.nodeInfo ?? null,
    recentEvents: ctx.recentEvents,
    currentLogs: ctx.currentLogs,
    previousLogs: ctx.previousLogs,
    gitRepoUrl: ctx.gitRepoUrl ?? null,
    gitManifestPath: ctx.gitManifestPath ?? null,
    gitManifestContent: ctx.gitManifestContent ?? null,
    needsHelmGeneration: ctx.needsHelmGeneration ?? null,
    repoSignals: ctx.repoSignals ?? null,
    priorActionSummary: ctx.priorActionSummary ?? null,
    namespaceExists: ctx.namespaceExists ?? null,
    namespaceQuotas: ctx.namespaceQuotas ?? null,
    existingDeployments: ctx.existingDeployments ?? null,
    specialistDiagnostics: ctx.specialistDiagnostics ?? null,
    rcaPointers: ctx.rcaPointers ?? null,
    observabilitySummary: ctx.observabilitySummary ?? null,
    retrievedPlaybook: ctx.retrievedPlaybook ?? null,
    detectedErrorSignature: ctx.detectedErrorSignature ?? null,
    targetComponent: ctx.targetComponent ?? null,
  };

  return `Here are the structured cluster facts for incident ${ctx.incidentId}:

\`\`\`json
${JSON.stringify(facts, null, 2)}
\`\`\`

${ctx.retrievedPlaybook ? `## OFFICIAL RUNBOOK (mandatory grounding)\n${ctx.retrievedPlaybook}\n\n` : ''}${ctx.observabilitySummary ? `Multi-source RCA summary:\n${ctx.observabilitySummary}\n\n` : ''}Analyze these facts and all RCA pointers. Cross-reference events, logs, and metrics before choosing root cause. Remember: only use information from the facts above.`;
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateRemediationPlan(obj: unknown): RemediationPlan {
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('LLM response is not an object');
  }

  const plan = obj as Record<string, unknown>;

  const requiredStrings = ['rootCause', 'reasoning', 'severity'] as const;
  for (const field of requiredStrings) {
    if (typeof plan[field] !== 'string' || (plan[field] as string).trim() === '') {
      throw new Error(`Missing or empty required string field: ${field}`);
    }
  }

  const validSeverities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  const severityRaw = String(plan['severity']).trim().toUpperCase();
  if (!validSeverities.includes(severityRaw)) {
    throw new Error(`Invalid severity value: ${plan['severity']}`);
  }
  plan['severity'] = severityRaw;

  if (!Array.isArray(plan['proposedPatch'])) {
    throw new Error('proposedPatch must be an array');
  }

  const validActions = ['restart', 'git_patch', 'helm_deploy', 'repo_apply', 'cicd_rerun', 'cicd_open_pr', 'cicd_code_pr', 'coding_agent_handoff', 'escalate_human', 'noop'];
  let action = (plan['action'] as string) ?? 'git_patch';
  if (!validActions.includes(action)) {
    action = 'git_patch';
  }

  const hasPatch = plan['proposedPatch'].length > 0;

  let targetManifestPath = '';
  if (plan['targetManifestPath'] !== undefined && plan['targetManifestPath'] !== null) {
    if (typeof plan['targetManifestPath'] !== 'string') {
      throw new Error('targetManifestPath must be a string');
    }
    targetManifestPath = plan['targetManifestPath'];
  }
  if ((hasPatch || action === 'git_patch') && action !== 'restart' && targetManifestPath.trim() === '' && action !== 'helm_deploy') {
    targetManifestPath = 'deployments/unknown.yaml';
  }

  let commitMessage = '';
  if (plan['commitMessage'] !== undefined && plan['commitMessage'] !== null) {
    if (typeof plan['commitMessage'] !== 'string') {
      throw new Error('commitMessage must be a string');
    }
    commitMessage = plan['commitMessage'];
  }
  if (hasPatch && commitMessage.trim() === '') {
    commitMessage = 'fix(sre-bot): automated remediation';
  }

  const validOps = ['replace', 'add', 'remove', 'test'];
  for (const op of plan['proposedPatch'] as unknown[]) {
    if (typeof op !== 'object' || op === null) {
      throw new Error('Each proposedPatch entry must be an object');
    }
    const patch = op as Record<string, unknown>;
    if (typeof patch['op'] !== 'string' || !validOps.includes(patch['op'])) {
      throw new Error(`Invalid patch op: ${patch['op']}`);
    }
    if (typeof patch['path'] !== 'string') {
      throw new Error('Each proposedPatch entry must have a string path');
    }
  }

  if (typeof plan['rollbackSafe'] !== 'boolean') {
    throw new Error('rollbackSafe must be a boolean');
  }

  if (!plan['action'] && !hasPatch && action === 'git_patch') {
    action = 'escalate_human';
  }

  return {
    action: action as RemediationPlan['action'],
    rootCause: plan['rootCause'] as string,
    reasoning: plan['reasoning'] as string,
    severity: plan['severity'] as RemediationPlan['severity'],
    proposedPatch: plan['proposedPatch'] as RemediationPlan['proposedPatch'],
    targetManifestPath,
    commitMessage,
    rollbackSafe: plan['rollbackSafe'] as boolean,
    helmChart: plan['helmChart'] as RemediationPlan['helmChart'],
    targetRepo: (plan['targetRepo'] as RemediationPlan['targetRepo']) ?? 'both',
    githubRepo: plan['githubRepo'] as string | undefined,
    gitRef: plan['gitRef'] as string | undefined,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Sends the DiagnosisContext to Gemini or OpenRouter with a strict JSON schema constraint
 * and returns a validated RemediationPlan.
 */
export async function diagnose(ctx: DiagnosisContext): Promise<RemediationPlan> {
  const llm = resolveBrainLlm();

  log('info', AGENT, 'Calling LLM for diagnosis', {
    incidentId: ctx.incidentId,
    model: llm.model,
    backend: llm.backend,
    namespace: ctx.namespace,
    resourceName: ctx.resourceName,
    mode: ctx.mode,
  });

  const userPrompt = buildUserPrompt(ctx);
  let rawText = '';

  if (llm.backend === 'openrouter') {
    rawText = await openRouterChat({
      model: llm.model,
      messages: [
        { role: 'system', content: await systemPrompt(ctx) },
        { role: 'user', content: userPrompt },
      ],
      jsonMode: true,
      temperature: 0.1,
      callerAgent: AGENT,
      incidentId: ctx.incidentId,
    });
  } else if (genai) {
    const response = await genai.models.generateContent({
      model: llm.model,
      contents: [
        {
          role: 'user',
          parts: [{ text: userPrompt }],
        },
      ],
      config: {
        systemInstruction: await systemPrompt(ctx),
        responseMimeType: 'application/json',
        responseSchema: remediationPlanSchema,
        temperature: 0.1,
        thinkingConfig: {
          includeThoughts: false,
        },
      },
    });

    rawText = response.text ?? '';
  } else {
    throw new Error(
      'Gemini native selected but GEMINI_API_KEY is missing. Set GEMINI_API_KEY or use OpenRouter.'
    );
  }

  if (!rawText || rawText.trim() === '') {
    throw new Error(
      `LLM returned empty response for incidentId=${ctx.incidentId}`,
    );
  }

  log('debug', AGENT, 'LLM raw response received', {
    incidentId: ctx.incidentId,
    responseLength: rawText.length,
  });

  const cleanedText = stripJsonFences(rawText);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleanedText);
  } catch (err) {
    throw new Error(
      `LLM response is not valid JSON for incidentId=${ctx.incidentId}: ${String(err)}\nRaw: ${rawText.slice(0, 500)}`,
    );
  }

  let plan: RemediationPlan;
  try {
    plan = validateRemediationPlan(parsed);
  } catch (err) {
    throw new Error(
      `LLM response failed schema validation for incidentId=${ctx.incidentId}: ${String(err)}\nParsed: ${JSON.stringify(parsed, null, 2)}`,
    );
  }

  log('info', AGENT, 'LLM diagnosis complete', {
    incidentId: ctx.incidentId,
    severity: plan.severity,
    action: plan.action,
    rootCause: plan.rootCause.slice(0, 120),
    patchOps: plan.proposedPatch.length,
    rollbackSafe: plan.rollbackSafe,
  });

  return plan;
}

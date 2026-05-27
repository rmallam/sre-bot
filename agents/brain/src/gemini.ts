/**
 * gemini.ts
 *
 * Calls the Gemini API or OpenRouter API with a strict JSON Schema response format
 * to eliminate hallucination risk and ensure the output always conforms to RemediationPlan.
 *
 * Supports switching between:
 *  1. Native Google GenAI API (if GEMINI_API_KEY is set)
 *  2. OpenRouter API (if OPENROUTER_API_KEY is set)
 */

import { GoogleGenAI, Type } from '@google/genai';
import type { DiagnosisContext, RemediationPlan } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';

const AGENT = 'brain-agent';

const GEMINI_API_KEY = process.env['GEMINI_API_KEY'];
const OPENROUTER_API_KEY = process.env['OPENROUTER_API_KEY'];
const GEMINI_MODEL = process.env['GEMINI_MODEL'] ?? 'google/gemini-2.5-pro';

if (!GEMINI_API_KEY && !OPENROUTER_API_KEY) {
  log('error', AGENT, 'Neither GEMINI_API_KEY nor OPENROUTER_API_KEY environment variable is set', {});
}

// ── Gemini client ─────────────────────────────────────────────────────────────

const genai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

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
   - "helm_deploy": pre-deploy GitOps mode when needsHelmGeneration is true — include helmChart.files with Chart.yaml, values.yaml, templates/
   - "repo_apply": pre-deploy direct mode where manifests/charts should be applied from source repo without any Git push
   - "escalate_human": insufficient data or CRITICAL risk
   - "noop": nothing to do
3. In "diagnose" mode: If you cannot determine a root cause, set action to "escalate_human" and proposedPatch to [].
4. In "pre-deploy" mode:
   - If needsHelmGeneration is true, set action to "helm_deploy" and populate helmChart.files
   - If gitManifestContent is provided, use action "git_patch"
   - If gitManifestContent is NOT provided, generate Deployment via git_patch (single "add" at path "")
5. Your proposedPatch MUST be valid RFC 6902 JSON Patch when action is git_patch.
6. targetManifestPath from gitManifestPath or deployments/<resourceName>.yaml (or deploy/helm/<resourceName> for helm)
7. commitMessage MUST follow Conventional Commits format.
8. Output JSON must include: action, rootCause, reasoning, severity, proposedPatch, targetManifestPath, commitMessage, rollbackSafe, and optionally helmChart, targetRepo.
Do not add conversational text outside the JSON object.`;

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
  };

  return `Here are the structured cluster facts for incident ${ctx.incidentId}:

\`\`\`json
${JSON.stringify(facts, null, 2)}
\`\`\`

Analyze these facts and produce a remediation plan. Remember: only use information from the facts above.`;
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
  if (!validSeverities.includes(plan['severity'] as string)) {
    throw new Error(`Invalid severity value: ${plan['severity']}`);
  }

  if (!Array.isArray(plan['proposedPatch'])) {
    throw new Error('proposedPatch must be an array');
  }

  const validActions = ['restart', 'git_patch', 'helm_deploy', 'repo_apply', 'escalate_human', 'noop'];
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

// ── OpenRouter Call ───────────────────────────────────────────────────────────

async function callOpenRouter(userPrompt: string): Promise<string> {
  const model = process.env['OPENROUTER_MODEL'] ?? GEMINI_MODEL;
  log('info', AGENT, 'Querying OpenRouter', { model });

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://github.com/frappe-operator/sre-bot',
      'X-Title': 'Kube SRE Bot',
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`OpenRouter HTTP ${res.status} error: ${errBody}`);
  }

  const data = (await res.json()) as any;
  const rawText = data?.choices?.[0]?.message?.content;
  if (!rawText) {
    throw new Error(`OpenRouter returned empty content: ${JSON.stringify(data)}`);
  }
  return rawText;
}

// Avoid referencing remediationPlanSchema before declaration
function reremediationPlanSchema() {
  return remediationPlanSchema;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Sends the DiagnosisContext to Gemini or OpenRouter with a strict JSON schema constraint
 * and returns a validated RemediationPlan.
 */
export async function diagnose(ctx: DiagnosisContext): Promise<RemediationPlan> {
  const model = OPENROUTER_API_KEY 
    ? (process.env['OPENROUTER_MODEL'] ?? GEMINI_MODEL)
    : GEMINI_MODEL;

  log('info', AGENT, 'Calling LLM for diagnosis', {
    incidentId: ctx.incidentId,
    model,
    namespace: ctx.namespace,
    resourceName: ctx.resourceName,
    mode: ctx.mode,
    apiType: OPENROUTER_API_KEY ? 'openrouter' : 'google-native',
  });

  const userPrompt = buildUserPrompt(ctx);
  let rawText = '';

  if (OPENROUTER_API_KEY) {
    rawText = await callOpenRouter(userPrompt);
  } else if (genai) {
    const response = await genai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: [{ text: userPrompt }],
        },
      ],
      config: {
        systemInstruction: SYSTEM_PROMPT,
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
    throw new Error('No LLM credentials configured. Set GEMINI_API_KEY or OPENROUTER_API_KEY.');
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

  let cleanedText = rawText.trim();
  if (cleanedText.startsWith('```')) {
    // Strip markdown code block wrapper if present
    cleanedText = cleanedText
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '')
      .trim();
  }

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

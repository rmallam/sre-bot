/**
 * UX-6 — Brain LLM CI classification when regex confidence is low.
 */

import type { CiDiagnosis, CiRunFacts } from '../../../shared/src/ci-types.js';
import { log } from '../../../shared/src/http.js';
import { resolveBrainLlm } from '../../../shared/src/llm-config.js';
import { openRouterChat, stripJsonFences } from '../../../shared/src/openrouter.js';
import { extractErrorHighlight } from '../../../shared/src/ci-diagnose.js';

const AGENT = 'brain-ci-classify';
const GEMINI_API_KEY = process.env['GEMINI_API_KEY'];

export interface CiClassifyRequest {
  incidentId: string;
  ciRun: CiRunFacts;
}

const SYSTEM = `You classify GitHub Actions CI failures from logs. Reply ONLY with valid JSON:
{
  "kind": "test_failure|build_failure|lint_failure|auth_failure|runner_failure|docker_failure|deploy_failure|git_push_failure|workflow_config|missing_dependency|timeout|cancelled|unknown",
  "fixCategory": "application_code|dependency_env|workflow_config|secrets_auth|transient_infra|unknown",
  "summary": "one sentence for the operator",
  "userGuidance": "what the operator should do next (plain language)",
  "suggestedAction": "report_only|rerun|open_pr|propose_code_pr|escalate_human",
  "confidence": 0.0-1.0
}
Rules:
- Do not suggest auto-fix for application_code — report_only
- transient_infra / git push 500 / runner issues → rerun when appropriate
- missing package in logs → dependency_env + propose_code_pr
- workflow YAML / action version issues → workflow_config + open_pr
- secrets/401/403 → secrets_auth + escalate_human`;

export async function classifyCiWithLlm(req: CiClassifyRequest): Promise<Partial<CiDiagnosis> | null> {
  const logExcerpt = (req.ciRun.logExcerpt ?? '').slice(-4000);
  const userPrompt = `Incident: ${req.incidentId}
Repo: ${req.ciRun.githubRepo}
Workflow: ${req.ciRun.workflowName} run #${req.ciRun.workflowRunId}
Branch: ${req.ciRun.branch}
Failed jobs: ${req.ciRun.failedJobs.map((j) => j.name).join(', ') || 'unknown'}

Log excerpt:
\`\`\`
${logExcerpt}
\`\`\``;

  try {
    const llm = resolveBrainLlm();
    let raw = '';

    if (llm.backend === 'openrouter') {
      raw = await openRouterChat({
        model: llm.model,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userPrompt },
        ],
        jsonMode: true,
        temperature: 0.1,
        callerAgent: AGENT,
        incidentId: req.incidentId,
      });
    } else if (llm.backend === 'gemini' && GEMINI_API_KEY) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${llm.model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${SYSTEM}\n\n${userPrompt}` }] }],
            generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
          }),
        }
      );
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    } else {
      return null;
    }

    const parsed = JSON.parse(stripJsonFences(raw)) as Partial<CiDiagnosis>;
    if (!parsed.fixCategory || !parsed.summary) return null;

    return {
      kind: parsed.kind ?? 'unknown',
      fixCategory: parsed.fixCategory,
      summary: parsed.summary,
      userGuidance: parsed.userGuidance,
      suggestedAction: parsed.suggestedAction ?? 'report_only',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.75,
      errorHighlight: extractErrorHighlight(logExcerpt),
    };
  } catch (err) {
    log('warn', AGENT, 'classifyCiWithLlm failed', { incidentId: req.incidentId, error: String(err) });
    return null;
  }
}

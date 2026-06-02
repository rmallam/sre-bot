/**
 * LLM planner for application-code CI failures (test/lint/build).
 */

import type { CiRepoContext } from '../../../shared/src/ci-repo-context.js';
import type { CiRunFacts } from '../../../shared/src/ci-types.js';
import type { CiCodePatch } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import { resolveBrainLlm } from '../../../shared/src/llm-config.js';
import { openRouterChat, stripJsonFences } from '../../../shared/src/openrouter.js';
import { skillsSystemAppendix } from '../../../shared/src/skills-loader.js';

const AGENT = 'brain-agent';

export interface CiAppFixPlanRequest {
  incidentId: string;
  ciRun: CiRunFacts;
  repoContext: CiRepoContext;
  attempt: number;
  maxAttempts: number;
  previousError?: string;
}

export interface CiAppFixPlanResponse {
  patches: CiCodePatch[];
  title: string;
  body: string;
  reasoning: string;
  confidence: number;
  testCommand?: string;
}

const SYSTEM = `You are a senior engineer fixing CI application-code failures (tests, lint, compile errors).

RULES:
1. Output ONLY valid JSON matching the schema.
2. Propose MINIMAL, reviewable changes — max 5 files, full file content per patch.
3. Fix the root cause shown in logs; do not refactor unrelated code.
4. Prefer fixing source/tests over disabling checks.
5. If a test snapshot is wrong, update the test or snapshot intentionally.
6. Suggest a local testCommand when obvious (e.g. npm test, pytest, go test ./...).
7. If you cannot fix safely, return empty patches.
${skillsSystemAppendix()}`;

function buildUserPrompt(req: CiAppFixPlanRequest): string {
  const d = req.ciRun.diagnosis;
  const files = req.repoContext.files
    .map((f) => `### ${f.path}\n\`\`\`\n${f.excerpt}\n\`\`\``)
    .join('\n\n');

  return `Incident: ${req.incidentId}
Attempt: ${req.attempt}/${req.maxAttempts}
Repo: ${req.ciRun.githubRepo} @ ${req.ciRun.branch}
Workflow: ${req.ciRun.workflowName} run #${req.ciRun.workflowRunId}
Category: ${d?.fixCategory ?? 'application_code'}
Summary: ${d?.summary ?? 'CI failed'}

Log excerpt:
\`\`\`
${(req.ciRun.logExcerpt ?? '').slice(-4000)}
\`\`\`

${req.previousError ? `Previous local test/build output:\n\`\`\`\n${req.previousError.slice(-2500)}\n\`\`\`\n` : ''}

Repository files:
${files || '(no files loaded)'}

Return JSON:
{
  "title": "fix(ci): ...",
  "body": "PR description",
  "reasoning": "what you changed and why",
  "confidence": 0.0-1.0,
  "testCommand": "optional shell command to verify locally",
  "patches": [{ "path": "src/foo.ts", "content": "full file" }]
}`;
}

function validateResponse(raw: unknown): CiAppFixPlanResponse {
  const o = raw as Record<string, unknown>;
  const patches: CiCodePatch[] = [];
  if (Array.isArray(o['patches'])) {
    for (const p of o['patches']) {
      if (typeof p !== 'object' || p === null) continue;
      const rec = p as Record<string, unknown>;
      if (typeof rec['path'] === 'string' && typeof rec['content'] === 'string') {
        if (rec['path'].includes('..') || rec['path'].startsWith('/')) continue;
        patches.push({ path: rec['path'], content: rec['content'] });
      }
    }
  }
  return {
    patches: patches.slice(0, 5),
    title: typeof o['title'] === 'string' ? o['title'] : 'fix(ci): application code',
    body: typeof o['body'] === 'string' ? o['body'] : '',
    reasoning: typeof o['reasoning'] === 'string' ? o['reasoning'] : '',
    confidence: typeof o['confidence'] === 'number' ? o['confidence'] : 0.5,
    testCommand: typeof o['testCommand'] === 'string' ? o['testCommand'] : undefined,
  };
}

export async function planCiAppFix(req: CiAppFixPlanRequest): Promise<CiAppFixPlanResponse> {
  const llm = resolveBrainLlm();
  log('info', AGENT, 'plan-app-fix', {
    incidentId: req.incidentId,
    attempt: req.attempt,
    repo: req.ciRun.githubRepo,
  });

  const rawText = await openRouterChat({
    model: llm.model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: buildUserPrompt(req) },
    ],
    jsonMode: true,
    temperature: 0.2,
    callerAgent: AGENT,
    incidentId: req.incidentId,
  });

  return validateResponse(JSON.parse(stripJsonFences(rawText)));
}

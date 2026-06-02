/**
 * Propose minimal file patches for CI dependency / env failures.
 */

import type { CiRepoContext } from '../../../shared/src/ci-repo-context.js';
import type { CiRunFacts } from '../../../shared/src/ci-types.js';
import type { CiCodePatch } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import { resolveBrainLlm } from '../../../shared/src/llm-config.js';
import { openRouterChat, stripJsonFences } from '../../../shared/src/openrouter.js';
import { skillsSystemAppendix } from '../../../shared/src/skills-loader.js';

const AGENT = 'brain-agent';

export interface CiCodeFixPlanRequest {
  incidentId: string;
  ciRun: CiRunFacts;
  repoContext: CiRepoContext;
}

export interface CiCodeFixPlanResponse {
  patches: CiCodePatch[];
  title: string;
  body: string;
  reasoning: string;
  confidence: number;
}

const SYSTEM = `You are a CI dependency fix planner. Given failed CI logs and repository file excerpts, propose MINIMAL file changes to fix missing dependencies or install steps.

RULES:
1. Output ONLY valid JSON matching the schema.
2. Prefer editing existing dependency files (requirements.txt, package.json, pyproject.toml, go.mod, Dockerfile) over large refactors.
3. You may add a workflow step ONLY if no dependency file exists and the log clearly requires an install command.
4. Maximum 3 files. Each file must be COMPLETE file content after your edit (not a diff).
5. Do not invent packages not implied by the error logs.
6. If you cannot propose a safe fix, return empty patches array.
${skillsSystemAppendix()}`;

function buildUserPrompt(req: CiCodeFixPlanRequest): string {
  const d = req.ciRun.diagnosis;
  const files = req.repoContext.files
    .map((f) => `### ${f.path}\n\`\`\`\n${f.excerpt}\n\`\`\``)
    .join('\n\n');

  return `Incident: ${req.incidentId}
Repo: ${req.ciRun.githubRepo} branch ${req.ciRun.branch}
Workflow: ${req.ciRun.workflowName} run #${req.ciRun.workflowRunId}
Diagnosis: ${d?.summary ?? 'unknown'}
Missing package hint: ${d?.missingPackage ?? 'none'} (${d?.missingEcosystem ?? 'n/a'})

Log excerpt:
\`\`\`
${(req.ciRun.logExcerpt ?? '').slice(-3500)}
\`\`\`

Repository files:
${files || '(no files loaded)'}

Workflow path: ${req.repoContext.workflowFilePath ?? 'unknown'}

Return JSON:
{
  "title": "fix(deps): ...",
  "body": "PR description markdown",
  "reasoning": "one paragraph",
  "confidence": 0.0-1.0,
  "patches": [{ "path": "requirements.txt", "content": "full file content" }]
}`;
}

function validateResponse(raw: unknown): CiCodeFixPlanResponse {
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
    patches: patches.slice(0, 3),
    title: typeof o['title'] === 'string' ? o['title'] : 'fix(ci): dependency fix',
    body: typeof o['body'] === 'string' ? o['body'] : '',
    reasoning: typeof o['reasoning'] === 'string' ? o['reasoning'] : '',
    confidence: typeof o['confidence'] === 'number' ? o['confidence'] : 0.5,
  };
}

export async function planCiCodeFix(req: CiCodeFixPlanRequest): Promise<CiCodeFixPlanResponse> {
  const llm = resolveBrainLlm();
  const userPrompt = buildUserPrompt(req);

  log('info', AGENT, 'plan-ci-fix', {
    incidentId: req.incidentId,
    repo: req.ciRun.githubRepo,
    fileCount: req.repoContext.files.length,
  });

  let rawText = '';
  if (llm.backend === 'openrouter') {
    rawText = await openRouterChat({
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
  } else {
    throw new Error('plan-ci-fix requires OpenRouter or extend gemini path');
  }

  const parsed = JSON.parse(stripJsonFences(rawText)) as unknown;
  return validateResponse(parsed);
}

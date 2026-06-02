/**
 * Build CI failure remediation plans including optional brain code-fix PRs.
 */

import type { CiRunFacts } from '../../../shared/src/ci-types.js';
import type { CiRepoContext } from '../../../shared/src/ci-repo-context.js';
import type { RemediationPlan } from '../../../shared/src/types.js';
import { buildCiRemediationPlan, applyCiCodeFixToPlan } from '../../../shared/src/ci-plan.js';
import { formatFetchError, log } from '../../../shared/src/http.js';

const AGENT = 'orchestrator-ci-failure-plan';
const CICD_URL = process.env['CICD_URL'] ?? 'http://cicd-agent:8080';
const BRAIN_URL = process.env['BRAIN_URL'] ?? 'http://brain-agent:8080';
export const CI_CODE_FIX_ENABLED =
  (process.env['CI_CODE_FIX_ENABLED'] ?? 'true').toLowerCase() === 'true';
export const CODING_AGENT_ENABLED =
  (process.env['CODING_AGENT_ENABLED'] ?? 'true').toLowerCase() === 'true';

export async function gatherCiRepoContext(ciRun: CiRunFacts): Promise<CiRepoContext> {
  const params = new URLSearchParams({
    repo: ciRun.githubRepo.startsWith('github.com/')
      ? ciRun.githubRepo
      : `github.com/${ciRun.githubRepo}`,
    branch: ciRun.branch,
  });
  if (ciRun.workflowName) params.set('workflowName', ciRun.workflowName);
  const res = await fetch(`${CICD_URL}/repo-context?${params}`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(formatFetchError('cicd repo-context', res.status, await res.text()));
  }
  return res.json() as Promise<CiRepoContext>;
}

async function callPlanCiFix(
  incidentId: string,
  ciRun: CiRunFacts,
  repoContext: CiRepoContext
): Promise<{
  patches: Array<{ path: string; content: string }>;
  title: string;
  body: string;
  reasoning: string;
}> {
  const res = await fetch(`${BRAIN_URL}/plan-ci-fix`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ incidentId, ciRun, repoContext }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`POST /plan-ci-fix failed ${res.status}: ${body.slice(0, 400)}`);
  }
  return res.json() as Promise<{
    patches: Array<{ path: string; content: string }>;
    title: string;
    body: string;
    reasoning: string;
  }>;
}

/** Plan for ci-failure mode: triage + optional dependency PR via brain, or coding-agent handoff. */
export async function buildFullCiFailurePlan(
  ciRun: CiRunFacts,
  incidentId: string
): Promise<RemediationPlan> {
  let plan = buildCiRemediationPlan(ciRun);

  if (
    plan.action === 'noop' &&
    ciRun.diagnosis?.fixCategory === 'application_code' &&
    CODING_AGENT_ENABLED
  ) {
    return {
      ...plan,
      action: 'coding_agent_handoff',
      reasoning: [
        ciRun.diagnosis.summary,
        ciRun.diagnosis.remediationHint,
        'Automated multi-file code fix via coding agent.',
      ]
        .filter(Boolean)
        .join(' '),
      githubRepo: ciRun.githubRepo,
      gitRef: ciRun.branch,
      cicd: {
        workflowRunId: ciRun.workflowRunId,
        workflowName: ciRun.workflowName,
        fixCategory: ciRun.diagnosis.fixCategory,
        logExcerpt: ciRun.logExcerpt?.slice(-4000),
      },
    };
  }

  if (plan.action !== 'cicd_code_pr') {
    return plan;
  }

  if (!CI_CODE_FIX_ENABLED) {
    log('info', AGENT, 'CI code fix disabled', { incidentId });
    return {
      ...plan,
      action: 'noop',
      reasoning: `${plan.reasoning} (CI_CODE_FIX_ENABLED=false — manual fix required.)`,
    };
  }

  try {
    const repoContext = await gatherCiRepoContext(ciRun);
    const fix = await callPlanCiFix(incidentId, ciRun, repoContext);
    if (!fix.patches.length) {
      return {
        ...plan,
        action: 'noop',
        reasoning: `${plan.reasoning} Brain could not propose a safe patch — fix manually.`,
      };
    }
    return applyCiCodeFixToPlan(plan, {
      patches: fix.patches,
      title: fix.title,
      body: fix.body,
      reasoning: fix.reasoning,
    });
  } catch (err) {
    log('warn', AGENT, 'CI code fix planning failed', { incidentId, error: String(err) });
    return {
      ...plan,
      action: 'noop',
      reasoning: `${plan.reasoning} Automated patch planning failed: ${String(err).slice(0, 200)}`,
    };
  }
}

import type { CiDiagnosis, CiRunFacts } from './ci-types.js';
import type { CiCodePatch, RemediationPlan } from './types.js';

/** Build a remediation plan for ci-failure mode from diagnosed run facts. */
export function buildCiRemediationPlan(facts: CiRunFacts): RemediationPlan {
  const d: CiDiagnosis =
    facts.diagnosis ??
    ({
      kind: 'unknown',
      fixCategory: 'unknown',
      summary: 'CI failure',
      suggestedAction: 'report_only',
      confidence: 0.5,
    } as CiDiagnosis);

  const action =
    d.suggestedAction === 'rerun'
      ? 'cicd_rerun'
      : d.suggestedAction === 'open_pr'
        ? 'cicd_open_pr'
        : d.suggestedAction === 'propose_code_pr'
          ? 'cicd_code_pr'
          : d.suggestedAction === 'escalate_human'
            ? 'escalate_human'
            : 'noop';

  const workflowPath =
    d.workflowFilePath ?? `.github/workflows/${slugifyWorkflowName(facts.workflowName)}.yml`;

  return {
    action,
    rootCause: d.summary,
    reasoning: [d.remediationHint, d.userGuidance].filter(Boolean).join(' '),
    severity:
      d.fixCategory === 'secrets_auth' || d.kind === 'auth_failure'
        ? 'HIGH'
        : d.fixCategory === 'dependency_env'
          ? 'MEDIUM'
          : 'MEDIUM',
    proposedPatch: [],
    targetManifestPath: workflowPath,
    commitMessage: d.prTitle ?? `ci: address ${facts.workflowName} failure`,
    rollbackSafe: true,
    githubRepo: facts.githubRepo,
    gitRef: facts.branch,
    cicd: {
      workflowRunId: facts.workflowRunId,
      workflowName: facts.workflowName,
      fixCategory: d.fixCategory,
      workflowFilePath: workflowPath,
      prTitle: d.prTitle,
      prBody: d.prBody,
      logExcerpt: facts.logExcerpt?.slice(-4000),
    },
  };
}

/** Apply brain-generated code patches onto a CI remediation plan. */
export function applyCiCodeFixToPlan(
  plan: RemediationPlan,
  opts: {
    patches: CiCodePatch[];
    title: string;
    body: string;
    reasoning: string;
  }
): RemediationPlan {
  if (!opts.patches.length) {
    return { ...plan, action: 'noop', reasoning: `${plan.reasoning} No safe patch generated.` };
  }
  return {
    ...plan,
    action: 'cicd_code_pr',
    rootCause: plan.rootCause,
    reasoning: opts.reasoning,
    commitMessage: opts.title,
    cicd: {
      ...plan.cicd!,
      prTitle: opts.title,
      prBody: opts.body,
      codePatches: opts.patches,
    },
  };
}

function slugifyWorkflowName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

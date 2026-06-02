import type { CiDiagnosis, CiFailureKind, CiFixCategory, CiRunFacts } from './ci-types.js';
import { parseMissingDependency } from './ci-dependency-parse.js';

function classifyFromLog(log: string): CiFailureKind {
  if (parseMissingDependency(log)) return 'missing_dependency';
  const lower = log.toLowerCase();
  if (/401|403|unauthorized|bad credentials|could not read username|authentication failed/i.test(log)) {
    return 'auth_failure';
  }
  if (/npm err|yarn error|pnpm err|cargo test|pytest|jest|vitest|go test.*fail|tests failed/i.test(log)) {
    return 'test_failure';
  }
  if (/eslint|prettier|golangci|lint failed|ruff check|black --check/i.test(log)) {
    return 'lint_failure';
  }
  if (/docker build|dockerfile|kaniko|buildkit|image pull|manifest unknown/i.test(log)) {
    return 'docker_failure';
  }
  if (
    /fatal: unable to access|remote: internal server error|error: 5\d\d|git push.*fail/i.test(log) &&
    /git/i.test(log)
  ) {
    return 'git_push_failure';
  }
  if (/no space left|waiting for a runner|job was not started/i.test(log)) {
    return 'runner_failure';
  }
  if (/node\.js 20 actions are deprecated|deprecated.*actions\//i.test(log)) {
    return 'workflow_config';
  }
  if (/helm|kubectl|kubeconfig|deploy to|argo cd/i.test(log) && /error|fail/i.test(log)) {
    return 'deploy_failure';
  }
  if (/timeout|timed out|exceeded/i.test(log)) {
    return 'timeout';
  }
  if (/npm run build|make build|mvn.*fail|gradle.*fail|compilation failed/i.test(log)) {
    return 'build_failure';
  }
  if (/workflow.*not valid|yaml syntax|unexpected value.*uses:/i.test(log)) {
    return 'workflow_config';
  }
  return 'unknown';
}

function fixCategoryFor(kind: CiFailureKind, log: string): CiFixCategory {
  switch (kind) {
    case 'missing_dependency':
      return 'dependency_env';
    case 'test_failure':
    case 'lint_failure':
    case 'build_failure':
      return 'application_code';
    case 'workflow_config':
      return 'workflow_config';
    case 'auth_failure':
      return 'secrets_auth';
    case 'git_push_failure':
    case 'runner_failure':
    case 'timeout':
    case 'cancelled':
      return 'transient_infra';
    case 'docker_failure':
      return /dockerfile/i.test(log) ? 'workflow_config' : 'application_code';
    case 'deploy_failure':
      return 'workflow_config';
    default:
      if (/uses:.*@v[0-9]+/.test(log) && /deprecated|unexpected|not found/i.test(log)) {
        return 'workflow_config';
      }
      return 'unknown';
  }
}

function suggestAction(category: CiFixCategory, kind: CiFailureKind): CiDiagnosis['suggestedAction'] {
  if (category === 'dependency_env') return 'propose_code_pr';
  if (category === 'application_code') {
    if (kind === 'test_failure' || kind === 'lint_failure') return 'report_only';
    return 'report_only';
  }
  if (category === 'secrets_auth') return 'escalate_human';
  if (category === 'workflow_config') return 'open_pr';
  if (category === 'transient_infra') {
    return kind === 'cancelled' || kind === 'git_push_failure' || kind === 'runner_failure' ? 'rerun' : 'rerun';
  }
  return 'report_only';
}

function remediationHint(category: CiFixCategory, kind: CiFailureKind): string {
  switch (category) {
    case 'application_code':
      if (kind === 'test_failure') return 'Fix failing tests or update snapshots in the application code, then push.';
      if (kind === 'lint_failure') return 'Run the linter locally, fix violations in source files, then push.';
      if (kind === 'build_failure') return 'Fix compile/build errors in the codebase shown below, then push.';
      return 'This failure requires changes in application source code. A coding agent can be used for multi-file fixes (see roadmap).';
    case 'dependency_env':
      return 'Add the missing dependency or install step (requirements.txt, package.json, Dockerfile, or workflow). The bot can propose a PR — approve when prompted.';
    case 'workflow_config':
      return 'Update GitHub Actions workflow configuration (YAML under .github/workflows/). The bot can open a PR for workflow fixes — approve when prompted.';
    case 'secrets_auth':
      return 'Check repository/org secrets, GITHUB_TOKEN permissions, and SSO authorization. This cannot be auto-fixed via PR.';
    case 'transient_infra':
      if (kind === 'git_push_failure') {
        return 'Git push failed (often a transient GitHub error). Re-run the workflow; if it persists, check branch protection and token scopes.';
      }
      return 'Often resolves on retry (runner availability, network, or platform glitch).';
    default:
      return 'Review the failed job log and workflow YAML.';
  }
}

function userGuidance(category: CiFixCategory, action: CiDiagnosis['suggestedAction']): string {
  switch (category) {
    case 'application_code':
      return 'No automated PR — fix the code locally, or use a coding agent (planned) for multi-step fixes.';
    case 'dependency_env':
      return 'The bot can open a PR with dependency/install changes — approve when prompted.';
    case 'workflow_config':
      return action === 'open_pr'
        ? 'A PR can be opened to update workflow files — you will be asked to approve.'
        : 'Review workflow YAML manually.';
    case 'secrets_auth':
      return 'Human review required for credentials/secrets.';
    case 'transient_infra':
      return action === 'rerun' ? 'Approve a workflow re-run if you want the bot to retry.' : 'Monitor and retry.';
    default:
      return 'Review the log excerpt below.';
  }
}

/** Pull the most relevant error lines for the operator. */
export function extractErrorHighlight(log: string, maxLines = 10): string[] {
  if (!log.trim()) return [];
  const lines = log.split('\n');
  const marked = lines.filter((l) =>
    /##\[error\]|##\[warning\].*deprecated|fatal:|error:|ERR!|AssertionError|✖|failed|exit code [1-9]/i.test(l)
  );
  const picked = (marked.length > 0 ? marked : lines.filter((l) => l.trim().length > 0)).slice(-maxLines);
  return picked.map((l) => l.trim()).filter(Boolean);
}

export function diagnoseCiRun(facts: Pick<CiRunFacts, 'logExcerpt' | 'conclusion' | 'failedJobs'>): CiDiagnosis {
  const log = facts.logExcerpt ?? '';
  if (facts.conclusion === 'cancelled') {
    return {
      kind: 'cancelled',
      fixCategory: 'transient_infra',
      summary: 'Workflow run was cancelled.',
      suggestedAction: 'rerun',
      confidence: 0.95,
      remediationHint: 'Re-run the workflow if cancellation was accidental.',
      userGuidance: userGuidance('transient_infra', 'rerun'),
      errorHighlight: extractErrorHighlight(log),
    };
  }

  const kind = classifyFromLog(log);
  const fixCategory = fixCategoryFor(kind, log);
  const suggestedAction = suggestAction(fixCategory, kind);
  const failedJob = facts.failedJobs[0]?.name ?? 'unknown job';
  const errorHighlight = extractErrorHighlight(log);
  const depHint = parseMissingDependency(log);

  const categoryLabel = fixCategory.replace(/_/g, ' ');
  const summary =
    fixCategory === 'dependency_env' && depHint
      ? `CI failed in job "${failedJob}" — missing dependency "${depHint.packageName}" (${depHint.ecosystem}).`
      : fixCategory === 'application_code'
      ? `CI failed in job "${failedJob}" — application code needs a fix (${kind.replace(/_/g, ' ')}).`
      : fixCategory === 'workflow_config'
        ? `CI failed in job "${failedJob}" — workflow / CI configuration issue (${kind.replace(/_/g, ' ')}).`
        : `CI failed in job "${failedJob}" (${categoryLabel}).`;

  const prTitle =
    suggestedAction === 'open_pr'
      ? `fix(ci): update workflow for ${failedJob} failure`
      : suggestedAction === 'propose_code_pr' && depHint
        ? `fix(deps): add ${depHint.packageName}`
        : undefined;
  const prBody =
    suggestedAction === 'open_pr'
      ? [
          '## CI failure (sre-bot)',
          '',
          summary,
          '',
          '### Error highlight',
          '```',
          errorHighlight.join('\n').slice(0, 2000),
          '```',
          '',
          remediationHint(fixCategory, kind),
        ].join('\n')
      : undefined;

  return {
    kind,
    fixCategory,
    summary,
    suggestedAction,
    confidence: fixCategory === 'unknown' ? 0.5 : 0.85,
    remediationHint: remediationHint(fixCategory, kind),
    userGuidance: userGuidance(fixCategory, suggestedAction),
    errorHighlight,
    missingPackage: depHint?.packageName,
    missingEcosystem: depHint?.ecosystem,
    prTitle,
    prBody,
  };
}

function escapeTelegram(text: string): string {
  return text.replace(/`/g, "'");
}

export function formatCiReport(facts: CiRunFacts): string {
  const d = facts.diagnosis;
  const lines = [
    `🔴 CI failed: ${facts.workflowName}`,
    `Repo: ${facts.githubRepo}`,
    `Branch: ${facts.branch} · Run #${facts.workflowRunId}`,
    `Link: ${facts.htmlUrl}`,
  ];
  if (facts.failedJobs.length) {
    lines.push(`Failed jobs: ${facts.failedJobs.map((j) => j.name).join(', ')}`);
  }

  if (d) {
    const categoryEmoji =
      d.fixCategory === 'application_code'
        ? '🧩'
        : d.fixCategory === 'dependency_env'
          ? '📦'
          : d.fixCategory === 'workflow_config'
          ? '⚙️'
          : d.fixCategory === 'secrets_auth'
            ? '🔐'
            : d.fixCategory === 'transient_infra'
              ? '🔄'
              : '❓';

    lines.push(
      '',
      `${categoryEmoji} Category: ${d.fixCategory.replace(/_/g, ' ')}`,
      `Diagnosis: ${d.summary}`,
      '',
      `What to do: ${d.userGuidance ?? d.remediationHint ?? ''}`
    );
    if (d.remediationHint && d.userGuidance && d.remediationHint !== d.userGuidance) {
      lines.push(`Hint: ${d.remediationHint}`);
    }
    if (d.suggestedAction === 'open_pr') {
      lines.push('', '📋 A workflow-fix PR can be opened after you approve in chat.');
    } else if (d.suggestedAction === 'propose_code_pr') {
      lines.push('', '📦 A dependency/code-fix PR can be proposed after you approve in chat.');
    } else if (d.suggestedAction === 'rerun') {
      lines.push('', '▶️ Approve in chat to re-run the workflow.');
    } else if (d.fixCategory === 'application_code') {
      lines.push('', '✋ No automated PR — fix the code and push yourself.');
    }

    if (d.errorHighlight && d.errorHighlight.length > 0) {
      lines.push('', 'Issue (from logs):');
      const block = d.errorHighlight.map((l) => escapeTelegram(l)).join('\n').slice(0, 1500);
      lines.push('```', block, '```');
    } else if (facts.logExcerpt) {
      lines.push('', 'Log excerpt:', '```', escapeTelegram(facts.logExcerpt.slice(-1200)), '```');
    }
  } else if (facts.logExcerpt) {
    lines.push('', 'Log excerpt:', '```', escapeTelegram(facts.logExcerpt.slice(-1200)), '```');
  }

  return lines.join('\n');
}

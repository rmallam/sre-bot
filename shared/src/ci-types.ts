/**
 * CI/CD domain types — GitHub Actions first; extensible to GitLab/Jenkins.
 */

export type CiFailureKind =
  | 'test_failure'
  | 'build_failure'
  | 'lint_failure'
  | 'auth_failure'
  | 'runner_failure'
  | 'docker_failure'
  | 'deploy_failure'
  | 'git_push_failure'
  | 'workflow_config'
  | 'missing_dependency'
  | 'timeout'
  | 'cancelled'
  | 'unknown';

/** Where the fix belongs — drives user messaging and automation. */
export type CiFixCategory =
  | 'application_code'
  | 'dependency_env'
  | 'workflow_config'
  | 'secrets_auth'
  | 'transient_infra'
  | 'unknown';

export type CiSuggestedAction =
  | 'report_only'
  | 'rerun'
  | 'open_pr'
  | 'propose_code_pr'
  | 'escalate_human';

export interface CiWorkflowRunSummary {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  branch: string;
  headSha: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  event: string;
}

export interface CiJobSummary {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  startedAt?: string;
  completedAt?: string;
}

export interface CiRunFacts {
  githubRepo: string;
  workflowRunId: number;
  workflowName: string;
  branch: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  event: string;
  failedJobs: CiJobSummary[];
  /** Truncated log excerpt from first failed job step. */
  logExcerpt?: string;
  diagnosis?: CiDiagnosis;
}

export interface CiDiagnosis {
  kind: CiFailureKind;
  fixCategory: CiFixCategory;
  summary: string;
  suggestedAction: CiSuggestedAction;
  confidence: number;
  remediationHint?: string;
  /** Short line for Telegram — what the operator should do next. */
  userGuidance?: string;
  /** Key log lines shown to the user. */
  errorHighlight?: string[];
  workflowFilePath?: string;
  prTitle?: string;
  prBody?: string;
  /** Parsed from logs when kind is missing_dependency. */
  missingPackage?: string;
  missingEcosystem?: string;
}

/**
 * Classify deploy/kubectl/helm failures so we do not retry unrelated strategies
 * (e.g. helm upgrade after kubectl TLS failure — same broken API connection).
 */

export type DeployFailureKind =
  | 'cluster_unreachable'
  | 'namespace_missing'
  | 'auth'
  | 'rbac'
  | 'helm_tooling'
  | 'manifest'
  | 'git'
  | 'unknown';

export interface DeployFailureAnalysis {
  kind: DeployFailureKind;
  /** Short operator-facing explanation */
  summary: string;
  /** Whether trying another deploy mechanism (helm vs kubectl) could help */
  alternateStrategyMayHelp: boolean;
  /** Suggested remediation the agent can attempt automatically */
  autoRemediations: ('kubeconfig_insecure_tls' | 'check_kube_api_host')[];
}

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.message}\n${err.stack ?? ''}`;
  return String(err);
}

export function classifyDeployFailure(err: unknown): DeployFailureAnalysis {
  const msg = errorText(err).toLowerCase();

  if (
    /namespaces? ["'][^"']+["'] not found/i.test(msg) ||
    /namespace.*not found/i.test(msg) ||
    /not found.*namespace/i.test(msg)
  ) {
    return {
      kind: 'namespace_missing',
      summary: 'Target namespace does not exist in the cluster.',
      alternateStrategyMayHelp: false,
      autoRemediations: [],
    };
  }

  if (
    /unable to connect to the server/i.test(msg) ||
    /x509:|certificate (is )?valid for|tls: failed to verify|certificate signed by unknown|hostname mismatch/i.test(
      msg
    ) ||
    /connection refused|dial tcp|no route to host|i\/o timeout|context deadline exceeded/i.test(
      msg
    ) ||
    /the server could not find the requested resource.*\/api/i.test(msg)
  ) {
    const tls = /x509|certificate|tls:/i.test(msg);
    return {
      kind: 'cluster_unreachable',
      summary: tls
        ? 'Cannot reach the Kubernetes API: TLS certificate does not match the API host (common when using Podman Desktop from a container).'
        : 'Cannot reach the Kubernetes API server from the gitops agent.',
      alternateStrategyMayHelp: false,
      autoRemediations: ['kubeconfig_insecure_tls', 'check_kube_api_host'],
    };
  }

  if (/spawn helm enoent|helm enoent/i.test(msg)) {
    return {
      kind: 'helm_tooling',
      summary: 'Helm binary is missing in the gitops container.',
      alternateStrategyMayHelp: true,
      autoRemediations: [],
    };
  }

  if (/lfstack\.push|fatal error: lfstack/i.test(msg)) {
    return {
      kind: 'helm_tooling',
      summary: 'Helm crashed in the container (often wrong CPU architecture).',
      alternateStrategyMayHelp: true,
      autoRemediations: [],
    };
  }

  if (/unauthorized|forbidden|cannot get|cannot create|rbac|permission denied/i.test(msg)) {
    const rbac = /forbidden|rbac|cannot /i.test(msg);
    return {
      kind: rbac ? 'rbac' : 'auth',
      summary: rbac
        ? 'Connected to the cluster but RBAC denied this operation.'
        : 'Authentication to the cluster failed.',
      alternateStrategyMayHelp: false,
      autoRemediations: [],
    };
  }

  if (/remote branch .+ not found|clone failed|git clone/i.test(msg)) {
    return {
      kind: 'git',
      summary: 'Git clone or branch resolution failed.',
      alternateStrategyMayHelp: false,
      autoRemediations: [],
    };
  }

  if (/invalid|failed to parse|error validating|admission webhook/i.test(msg)) {
    return {
      kind: 'manifest',
      summary: 'Manifest or chart validation failed against the API server.',
      alternateStrategyMayHelp: true,
      autoRemediations: [],
    };
  }

  return {
    kind: 'unknown',
    summary: 'Deploy command failed.',
    alternateStrategyMayHelp: false,
    autoRemediations: [],
  };
}

/** For orchestrator / brain context */
export function describeDeployFailureForPlanner(err: unknown): string {
  const a = classifyDeployFailure(err);
  const fixes =
    a.autoRemediations.length > 0
      ? ` Suggested fix: ${a.autoRemediations.join(', ')}.`
      : '';
  return `deploy_failed[${a.kind}]: ${a.summary}${fixes}`;
}

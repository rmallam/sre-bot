/**
 * Enterprise SRE task taxonomy — coded handlers vs RAG runbooks.
 *
 * Coded tasks map to existing commander/orchestrator/investigator endpoints.
 * RAG tasks are seeded into pgvector and retrieved at plan or advisory time.
 */

export type SreTaskHandler = 'coded' | 'rag' | 'async-run';

export type SreTaskScenario =
  // ── Coded (sync API or deterministic pipeline) ──
  | 'cluster-health'
  | 'namespace-health'
  | 'workload-status'
  | 'get-resources'
  | 'verify-workload'
  | 'app-review'
  | 'list-apps'
  | 'investigate-workload'
  | 'investigate-event'
  | 'investigate-app'
  | 'deploy-app'
  | 'rollback-release'
  | 'delete-workload'
  | 'restart-rollout'
  | 'ci-failure'
  | 'scale-workload'
  // ── RAG (error-signature grounding during remediation) ──
  | 'rag-crash-loop'
  | 'rag-oom-killed'
  | 'rag-image-pull'
  | 'rag-failed-mount'
  | 'rag-failed-scheduling'
  | 'rag-evicted'
  | 'rag-config-error'
  // ── RAG (advisory / procedural — no live cluster action) ──
  | 'rag-disaster-recovery'
  | 'rag-capacity-planning'
  | 'rag-security-incident'
  | 'rag-certificate-rotation'
  | 'rag-database-failover'
  | 'rag-network-policy'
  | 'rag-postmortem'
  | 'rag-slo-burn-rate'
  | 'rag-incident-command'
  | 'rag-node-drain'
  | 'rag-etcd-backup';

export interface SreTaskProfile {
  scenario: SreTaskScenario;
  handler: SreTaskHandler;
  description: string;
  /** Coded: commander ParsedCommand type or investigator endpoint */
  codedRoute?: string;
  /** RAG: error_signature stored in pgvector */
  ragSignature?: string;
  ragComponent?: 'compute' | 'storage' | 'network' | 'gitops' | 'database' | 'security';
}

export const SRE_TASK_MATRIX: SreTaskProfile[] = [
  { scenario: 'cluster-health', handler: 'coded', description: 'Cluster-wide node and deployment health', codedRoute: 'investigator:/cluster-health' },
  { scenario: 'namespace-health', handler: 'coded', description: 'Namespace deployment readiness summary', codedRoute: 'investigate:namespace' },
  { scenario: 'workload-status', handler: 'coded', description: 'Is deployment/pod running and ready', codedRoute: 'investigator:/workload-status' },
  { scenario: 'get-resources', handler: 'coded', description: 'List pods, deployments, nodes, events', codedRoute: 'investigator:/get' },
  { scenario: 'verify-workload', handler: 'coded', description: 'Post-remediation health verify', codedRoute: 'investigator:/verify' },
  { scenario: 'app-review', handler: 'coded', description: 'App graph review before deploy', codedRoute: 'investigator:/app-review' },
  { scenario: 'list-apps', handler: 'coded', description: 'Catalog and discovered apps', codedRoute: 'investigator:/apps' },
  { scenario: 'investigate-workload', handler: 'async-run', description: 'RCA for failing deployment', codedRoute: 'orchestrator:investigate' },
  { scenario: 'investigate-event', handler: 'async-run', description: 'Investigate K8s event reason', codedRoute: 'orchestrator:investigate:event' },
  { scenario: 'investigate-app', handler: 'async-run', description: 'End-to-end app investigation', codedRoute: 'orchestrator:investigate:app' },
  { scenario: 'deploy-app', handler: 'async-run', description: 'Deploy from Git, image, or stack', codedRoute: 'orchestrator:pre-deploy' },
  { scenario: 'rollback-release', handler: 'async-run', description: 'Roll back deployment or Helm release', codedRoute: 'orchestrator:rollback' },
  { scenario: 'delete-workload', handler: 'async-run', description: 'Remove deployment from namespace', codedRoute: 'orchestrator:delete' },
  { scenario: 'restart-rollout', handler: 'async-run', description: 'Rollout restart via annotation', codedRoute: 'executor:restart' },
  { scenario: 'ci-failure', handler: 'async-run', description: 'Diagnose failed GitHub Actions workflow', codedRoute: 'orchestrator:ci-failure' },
  { scenario: 'scale-workload', handler: 'async-run', description: 'Scale replicas via git_patch', codedRoute: 'orchestrator:git_patch' },

  { scenario: 'rag-crash-loop', handler: 'rag', description: 'CrashLoopBackOff playbook', ragSignature: 'CrashLoopBackOff', ragComponent: 'compute' },
  { scenario: 'rag-oom-killed', handler: 'rag', description: 'OOMKilled memory limit playbook', ragSignature: 'OOMKilled', ragComponent: 'compute' },
  { scenario: 'rag-image-pull', handler: 'rag', description: 'ImagePullBackOff registry playbook', ragSignature: 'ImagePullBackOff', ragComponent: 'gitops' },
  { scenario: 'rag-failed-mount', handler: 'rag', description: 'FailedMount PVC/volume playbook', ragSignature: 'FailedMount', ragComponent: 'storage' },
  { scenario: 'rag-failed-scheduling', handler: 'rag', description: 'FailedScheduling affinity/taint playbook', ragSignature: 'FailedScheduling', ragComponent: 'compute' },
  { scenario: 'rag-evicted', handler: 'rag', description: 'Evicted pod disk-pressure playbook', ragSignature: 'Evicted', ragComponent: 'compute' },
  { scenario: 'rag-config-error', handler: 'rag', description: 'CreateContainerConfigError secret/config playbook', ragSignature: 'CreateContainerConfigError', ragComponent: 'compute' },

  { scenario: 'rag-disaster-recovery', handler: 'rag', description: 'DR failover procedure', ragSignature: 'DisasterRecovery', ragComponent: 'compute' },
  { scenario: 'rag-capacity-planning', handler: 'rag', description: 'Capacity and autoscaling review', ragSignature: 'CapacityPlanning', ragComponent: 'compute' },
  { scenario: 'rag-security-incident', handler: 'rag', description: 'Security incident response', ragSignature: 'SecurityIncident', ragComponent: 'security' },
  { scenario: 'rag-certificate-rotation', handler: 'rag', description: 'TLS cert expiry rotation', ragSignature: 'CertificateRotation', ragComponent: 'network' },
  { scenario: 'rag-database-failover', handler: 'rag', description: 'Database failover procedure', ragSignature: 'DatabaseFailover', ragComponent: 'database' },
  { scenario: 'rag-network-policy', handler: 'rag', description: 'NetworkPolicy connectivity debug', ragSignature: 'NetworkPolicyDebug', ragComponent: 'network' },
  { scenario: 'rag-postmortem', handler: 'rag', description: 'Incident postmortem template', ragSignature: 'PostmortemTemplate', ragComponent: 'compute' },
  { scenario: 'rag-slo-burn-rate', handler: 'rag', description: 'SLO error budget burn analysis', ragSignature: 'SLOBurnRate', ragComponent: 'compute' },
  { scenario: 'rag-incident-command', handler: 'rag', description: 'Incident commander checklist', ragSignature: 'IncidentCommand', ragComponent: 'compute' },
  { scenario: 'rag-node-drain', handler: 'rag', description: 'Safe node drain procedure', ragSignature: 'NodeDrain', ragComponent: 'compute' },
  { scenario: 'rag-etcd-backup', handler: 'rag', description: 'etcd backup and restore', ragSignature: 'EtcdBackupRestore', ragComponent: 'compute' },
];

/** Error signatures extracted from facts for RAG grounding during remediation. */
export const SRE_RAG_ERROR_SIGNATURES = SRE_TASK_MATRIX.filter(
  (t) => t.handler === 'rag' && t.ragSignature && t.ragComponent !== undefined
)
  .filter((t) =>
    [
      'CrashLoopBackOff',
      'OOMKilled',
      'ImagePullBackOff',
      'FailedMount',
      'FailedScheduling',
      'Evicted',
      'CreateContainerConfigError',
    ].includes(t.ragSignature!)
  )
  .map((t) => t.ragSignature!);

export function profileForScenario(scenario: SreTaskScenario): SreTaskProfile | undefined {
  return SRE_TASK_MATRIX.find((t) => t.scenario === scenario);
}

export function ragProfiles(): SreTaskProfile[] {
  return SRE_TASK_MATRIX.filter((t) => t.handler === 'rag');
}

export function codedProfiles(): SreTaskProfile[] {
  return SRE_TASK_MATRIX.filter((t) => t.handler === 'coded');
}

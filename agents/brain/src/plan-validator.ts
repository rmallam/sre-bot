import type {
  PlanValidationIssue,
  PlanValidationRequest,
  PlanValidationResult,
} from '../../../shared/src/types.js';

const PROD_NS = (process.env['SECURITY_PROD_NAMESPACES'] ?? 'production,prod')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function isProdNamespace(ns: string): boolean {
  return PROD_NS.includes(ns.toLowerCase());
}

export async function validatePlanPreflight(
  req: PlanValidationRequest
): Promise<PlanValidationResult> {
  const issues: PlanValidationIssue[] = [];
  const plan = req.plan;
  const prod = isProdNamespace(req.namespace);

  for (const op of plan.proposedPatch ?? []) {
    if ((op.path ?? '').includes('persistentvolumeclaim') && op.op === 'remove') {
      issues.push({
        code: 'pvc_remove',
        severity: 'HIGH',
        message: 'Plan removes PersistentVolumeClaim data path',
        path: op.path,
      });
    }
    if ((op.path ?? '').includes('/spec/volumes') && op.op === 'remove') {
      issues.push({
        code: 'volume_remove',
        severity: 'HIGH',
        message: 'Plan removes workload volume definition',
        path: op.path,
      });
    }
    if ((op.path ?? '').includes('/metadata/finalizers') && op.op === 'remove') {
      issues.push({
        code: 'finalizer_remove',
        severity: 'MEDIUM',
        message: 'Plan removes Kubernetes finalizers',
        path: op.path,
      });
    }
  }

  if (prod && (plan.action === 'repo_apply' || plan.action === 'helm_deploy' || plan.action === 'git_patch')) {
    const text = `${plan.reasoning} ${plan.rootCause}`.toLowerCase();
    const dbRisk = /\b(database|postgres|mysql|mariadb|redis|stateful|persistence)\b/.test(text);
    const backupMention = /\b(backup|snapshot|restore plan)\b/.test(text);
    if (dbRisk && !backupMention) {
      issues.push({
        code: 'prod_db_no_backup',
        severity: 'HIGH',
        message: 'Production data-store risk detected without backup/rollback mention',
      });
    }
  }

  const hasHigh = issues.some((i) => i.severity === 'HIGH');
  const requiresHumanApproval = hasHigh || (prod && plan.action !== 'noop');
  return {
    allowed: !hasHigh,
    requiresHumanApproval,
    issues,
    summary:
      issues.length === 0
        ? 'Preflight validation passed.'
        : `Preflight found ${issues.length} issue(s): ${issues.map((i) => i.code).join(', ')}`,
  };
}

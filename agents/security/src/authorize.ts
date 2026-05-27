import type {
  AuthorizeActionRequest,
  AuthorizeActionResult,
  SecurityFinding,
} from '../../../../shared/src/types.js';
import { validatePatch } from './rules/patch-validator.js';
import { validateHelmChart } from './rules/helm-validator.js';

const ALLOWED_NS = (process.env['SECURITY_ALLOWED_NAMESPACES'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const PROD_NS = (process.env['SECURITY_PROD_NAMESPACES'] ?? 'production,prod')
  .split(',')
  .map((s) => s.trim().toLowerCase());

const ALLOWED_ACTIONS = (process.env['SECURITY_ALLOWED_ACTIONS'] ?? 'restart,git_patch,helm_deploy,repo_apply,noop,escalate_human')
  .split(',')
  .map((s) => s.trim());

export function authorizeAction(req: AuthorizeActionRequest): AuthorizeActionResult {
  const findings: SecurityFinding[] = [];
  const { plan, namespace, resourceName, incidentId } = req;

  if (!ALLOWED_ACTIONS.includes(plan.action)) {
    return {
      allowed: false,
      reason: `Action ${plan.action} not in allowlist`,
      findings,
      forceHil: true,
    };
  }

  if (ALLOWED_NS.length > 0 && !ALLOWED_NS.includes(namespace)) {
    findings.push({
      type: 'namespace_denied',
      severity: 'HIGH',
      action: 'blocked',
      message: `Namespace ${namespace} not allowed`,
    });
    return {
      allowed: false,
      reason: `Namespace ${namespace} denied`,
      findings,
      forceHil: true,
    };
  }

  const isProd = PROD_NS.includes(namespace.toLowerCase());
  let forceHil = isProd && (
    plan.action === 'helm_deploy' ||
    plan.action === 'repo_apply' ||
    plan.action === 'git_patch'
  );

  if (plan.action === 'git_patch') {
    const patchCheck = validatePatch(plan.proposedPatch, undefined);
    if (!patchCheck.allowed) {
      findings.push({
        type: 'patch_denied',
        severity: 'HIGH',
        action: 'blocked',
        message: patchCheck.reason ?? 'Patch denied',
      });
      return {
        allowed: false,
        reason: patchCheck.reason ?? 'Patch denied',
        findings,
        forceHil: true,
      };
    }
  }

  if (plan.action === 'helm_deploy' && plan.helmChart?.files) {
    const helmCheck = validateHelmChart(plan.helmChart.files);
    if (!helmCheck.allowed) {
      findings.push({
        type: 'helm_denied',
        severity: 'HIGH',
        action: 'blocked',
        message: helmCheck.reason ?? 'Helm chart denied',
      });
      return {
        allowed: false,
        reason: helmCheck.reason ?? 'Helm chart denied',
        findings,
        forceHil: true,
      };
    }
  }

  if (plan.action === 'escalate_human') {
    return { allowed: true, reason: 'Escalation plan', findings, forceHil: true };
  }

  return {
    allowed: true,
    reason: `Authorized ${plan.action} for ${namespace}/${resourceName} (${incidentId})`,
    findings,
    forceHil,
  };
}

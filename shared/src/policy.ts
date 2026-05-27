/**
 * Autonomy policy engine — decides auto-execute vs HIL (complements security-agent).
 */

import type {
  AutonomyMode,
  PolicyGateResult,
  RemediationAction,
  RemediationPlan,
  Severity,
} from './types.js';

const AUTONOMY_MODE = (process.env['AUTONOMY_MODE'] ?? 'low_risk_only') as AutonomyMode;

const PROD_NS = (process.env['AUTONOMY_PROD_NAMESPACES'] ?? 'production,prod')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const ALLOWED_NS = (process.env['AUTONOMY_ALLOWED_NAMESPACES'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isProdNamespace(namespace: string): boolean {
  return PROD_NS.includes(namespace.toLowerCase());
}

function namespaceAllowed(namespace: string): boolean {
  if (ALLOWED_NS.length === 0) return true;
  return ALLOWED_NS.includes(namespace);
}

export function getAutonomyMode(): AutonomyMode {
  return AUTONOMY_MODE;
}

export function evaluatePolicyGate(
  plan: RemediationPlan,
  namespace: string,
  forceHil: boolean
): PolicyGateResult {
  if (forceHil) {
    return { autoExecute: false, reason: 'Security agent requires human approval' };
  }

  if (!namespaceAllowed(namespace)) {
    return { autoExecute: false, reason: `Namespace ${namespace} not in AUTONOMY_ALLOWED_NAMESPACES` };
  }

  if (plan.action === 'escalate_human' || plan.action === 'noop') {
    return { autoExecute: false, reason: 'Plan requires human handling' };
  }

  if (AUTONOMY_MODE === 'hil_all') {
    return { autoExecute: false, reason: 'AUTONOMY_MODE=hil_all' };
  }

  const prod = isProdNamespace(namespace);
  const action = plan.action;

  if (AUTONOMY_MODE === 'full') {
    if (prod && (action === 'helm_deploy' || action === 'repo_apply' || plan.severity === 'CRITICAL')) {
      return { autoExecute: false, reason: 'Prod deploy/CRITICAL requires HIL even in full mode' };
    }
    return { autoExecute: true, reason: 'AUTONOMY_MODE=full' };
  }

  // low_risk_only
  if ((action === 'helm_deploy' || action === 'repo_apply') && !prod) {
    return { autoExecute: true, reason: 'Deploy auto-approved in non-prod namespace' };
  }

  if (action === 'restart' && !prod) {
    return { autoExecute: true, reason: 'Low-risk restart in non-prod namespace' };
  }

  if (action === 'restart' && prod && plan.rollbackSafe) {
    return { autoExecute: true, reason: 'Rollback-safe restart in prod' };
  }

  return {
    autoExecute: false,
    reason: `Action ${action} in ${namespace} requires HIL under low_risk_only`,
  };
}

export function isLowRiskAction(action: RemediationAction): boolean {
  return action === 'restart' || action === 'noop';
}

export function severityRequiresHil(severity: Severity): boolean {
  return severity === 'CRITICAL';
}

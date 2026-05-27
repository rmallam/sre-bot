/**
 * Per-tool policy gates (complements plan-level policy).
 */

import type { PolicyGateResult } from './types.js';
import type { CompiledPlan } from './tool-registry.js';
import { TOOL_REGISTRY } from './tool-registry.js';
import { getAutonomyMode } from './policy.js';

const PROD_NS = (process.env['AUTONOMY_PROD_NAMESPACES'] ?? 'production,prod')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export function isProdNamespace(namespace: string): boolean {
  return PROD_NS.includes(namespace.toLowerCase());
}

export function evaluateCompiledToolPolicy(
  compiled: CompiledPlan,
  namespace: string,
  forceHil: boolean
): PolicyGateResult {
  if (forceHil) {
    return { autoExecute: false, reason: 'Security agent requires human approval' };
  }

  if (compiled.calls.length === 0) {
    return { autoExecute: false, reason: compiled.fallbackReason ?? 'No executable tools' };
  }

  const mode = getAutonomyMode();
  if (mode === 'hil_all') {
    return { autoExecute: false, reason: 'AUTONOMY_MODE=hil_all' };
  }

  const prod = isProdNamespace(namespace);
  const highRiskTools = compiled.calls.filter((c) => TOOL_REGISTRY[c.name].requiresHilInProd);

  if (prod && highRiskTools.length > 0 && mode !== 'full') {
    return {
      autoExecute: false,
      reason: `Prod namespace requires HIL for: ${highRiskTools.map((t) => t.name).join(', ')}`,
    };
  }

  if (prod && compiled.riskLevel === 'high' && mode === 'full') {
    return {
      autoExecute: false,
      reason: 'High-risk compiled plan in prod requires HIL even in full mode',
    };
  }

  return { autoExecute: true, reason: 'Tool policy passed' };
}

export function evaluateCombinedPolicy(
  planGate: PolicyGateResult,
  toolGate: PolicyGateResult
): PolicyGateResult {
  if (!planGate.autoExecute) return planGate;
  if (!toolGate.autoExecute) return toolGate;
  return { autoExecute: true, reason: `${planGate.reason}; ${toolGate.reason}` };
}

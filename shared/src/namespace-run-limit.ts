/**
 * Namespace-wide run circuit breaker — limits concurrent active runs per namespace.
 */

export interface NamespaceRunLimitConfig {
  enabled: boolean;
  maxActive: number;
}

export function resolveNamespaceRunLimit(): NamespaceRunLimitConfig {
  const maxRaw = process.env['NAMESPACE_RUN_LIMIT'] ?? process.env['NAMESPACE_MAX_ACTIVE_RUNS'];
  const maxActive = maxRaw != null && maxRaw.trim() !== '' ? parseInt(maxRaw, 10) : 0;
  if (!Number.isFinite(maxActive) || maxActive <= 0) {
    return { enabled: false, maxActive: 0 };
  }
  return { enabled: true, maxActive };
}

export function namespaceRunLimitExceeded(
  activeCount: number,
  config: NamespaceRunLimitConfig = resolveNamespaceRunLimit()
): boolean {
  if (!config.enabled) return false;
  return activeCount >= config.maxActive;
}

/**
 * circuit-breaker.ts
 *
 * Fixes Issue #3 — Circuit Breaker state is persisted in Kubernetes CRD,
 * so it survives pod restarts (no more in-memory amnesia).
 *
 * CRD: sre.bot / v1 / SREIncident (plural: sreincidents)
 *
 * The circuit breaker reads and writes the `status.attemptCount` field
 * on the SREIncident custom resource that corresponds to the affected
 * (namespace, resourceName) pair.  If the CR doesn't exist it is created
 * on first write.
 */

import * as k8s from '@kubernetes/client-node';
import { existsSync } from 'node:fs';
import { log } from '../../../shared/src/http.js';

const AGENT = 'brain-agent';
const CRD_GROUP = 'sre.bot';
const CRD_VERSION = 'v1';
const CRD_PLURAL = 'sreincidents';

export const CIRCUIT_BREAKER_LIMIT = parseInt(
  process.env['CIRCUIT_BREAKER_LIMIT'] ?? '3',
  10,
);

// ── Singleton k8s client ──────────────────────────────────────────────────────

function buildClient(): k8s.CustomObjectsApi {
  const kc = new k8s.KubeConfig();
  // Prefer in-cluster config (running inside the pod); fall back to ~/.kube/config for local dev.
  const hasToken = existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token');
  if (hasToken) {
    try {
      kc.loadFromCluster();
    } catch {
      kc.loadFromDefault();
    }
  } else {
    kc.loadFromDefault();
  }
  return kc.makeApiClient(k8s.CustomObjectsApi);
}

const customObjectsApi = buildClient();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Converts a resource name to a valid Kubernetes CR name.
 * CR names must be lowercase alphanumeric + hyphens.
 */
function crName(resourceName: string): string {
  return resourceName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/**
 * Attempt to read an existing SREIncident CR.
 * Returns the body or null if it doesn't exist.
 */
async function readCR(
  namespace: string,
  name: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await customObjectsApi.getNamespacedCustomObject(
      CRD_GROUP,
      CRD_VERSION,
      namespace,
      CRD_PLURAL,
      name,
    );
    return res.body as Record<string, unknown>;
  } catch (err: unknown) {
    const httpErr = err as { response?: { statusCode?: number } };
    if (httpErr?.response?.statusCode === 404) {
      return null;
    }
    // If K8s API is down or config is missing, log a warning and return null (treat as 0 attempts)
    log('warn', AGENT, 'Failed to read circuit breaker CRD from K8s API — fallback to new incident state', {
      error: String(err),
    });
    return null;
  }
}

/**
 * Create a fresh SREIncident CR with attemptCount = 0.
 */
async function createCR(
  namespace: string,
  name: string,
  resourceName: string,
  incidentId: string,
): Promise<void> {
  const body = {
    apiVersion: `${CRD_GROUP}/${CRD_VERSION}`,
    kind: 'SREIncident',
    metadata: {
      name,
      namespace,
      labels: {
        'sre.bot/resource': resourceName,
      },
    },
    spec: {
      resourceName,
    },
    status: {
      incidentId,
      namespace,
      resourceName,
      attemptCount: 0,
      lastAttemptAt: new Date().toISOString(),
      approvalStatus: 'PENDING',
      escalated: false,
    },
  };

  await customObjectsApi.createNamespacedCustomObject(
    CRD_GROUP,
    CRD_VERSION,
    namespace,
    CRD_PLURAL,
    body,
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the current attemptCount for the given resource.
 * Returns 0 if the CR does not yet exist.
 */
export async function getAttemptCount(
  namespace: string,
  resourceName: string,
): Promise<number> {
  const name = crName(resourceName);
  const cr = await readCR(namespace, name);
  if (!cr) {
    log('info', AGENT, 'SREIncident CR not found — treating attemptCount as 0', {
      namespace,
      resourceName,
    });
    return 0;
  }
  const status = cr['status'] as Record<string, unknown> | undefined;
  const count = status?.['attemptCount'];
  return typeof count === 'number' ? count : 0;
}

/**
 * Increments the attemptCount on the CR, creating it first if necessary.
 * Returns the new count.
 */
export async function incrementAttemptCount(
  namespace: string,
  resourceName: string,
  incidentId: string,
): Promise<number> {
  const name = crName(resourceName);

  // Ensure the CR exists
  let cr = await readCR(namespace, name);
  if (!cr) {
    log('info', AGENT, 'Creating SREIncident CR', { namespace, resourceName, incidentId });
    await createCR(namespace, name, resourceName, incidentId);
    cr = await readCR(namespace, name);
  }

  const status = (cr?.['status'] as Record<string, unknown> | undefined) ?? {};
  const current = typeof status['attemptCount'] === 'number' ? status['attemptCount'] : 0;
  const next = current + 1;

  // Patch the status sub-resource
  const patch = {
    status: {
      attemptCount: next,
      lastAttemptAt: new Date().toISOString(),
      incidentId: incidentId,
    }
  };

  await customObjectsApi.patchNamespacedCustomObjectStatus(
    CRD_GROUP,
    CRD_VERSION,
    namespace,
    CRD_PLURAL,
    name,
    patch,
    undefined,
    undefined,
    undefined,
    { headers: { 'Content-Type': 'application/merge-patch+json' } },
  );

  log('info', AGENT, `Circuit breaker: attemptCount incremented to ${next}`, {
    namespace,
    resourceName,
    incidentId,
    attemptCount: next,
  });

  return next;
}

/**
 * Resets the attemptCount to 0 (called after a successful remediation).
 */
export async function resetAttemptCount(
  namespace: string,
  resourceName: string,
): Promise<void> {
  const name = crName(resourceName);
  const cr = await readCR(namespace, name);
  if (!cr) {
    log('warn', AGENT, 'resetAttemptCount: CR not found, nothing to reset', {
      namespace,
      resourceName,
    });
    return;
  }

  const patch = {
    status: {
      attemptCount: 0,
      escalated: false,
      approvalStatus: 'DONE',
      resolvedAt: new Date().toISOString(),
    }
  };

  await customObjectsApi.patchNamespacedCustomObjectStatus(
    CRD_GROUP,
    CRD_VERSION,
    namespace,
    CRD_PLURAL,
    name,
    patch,
    undefined,
    undefined,
    undefined,
    { headers: { 'Content-Type': 'application/merge-patch+json' } },
  );

  log('info', AGENT, 'Circuit breaker reset', { namespace, resourceName });
}

/**
 * Marks the incident as escalated on the CR.
 * Called when the circuit breaker limit is reached.
 */
export async function markEscalated(
  namespace: string,
  resourceName: string,
): Promise<void> {
  const name = crName(resourceName);
  const cr = await readCR(namespace, name);
  if (!cr) {
    log('warn', AGENT, 'markEscalated: CR not found, cannot mark escalated', {
      namespace,
      resourceName,
    });
    return;
  }

  const patch = {
    status: {
      escalated: true,
      approvalStatus: 'PENDING',
      lastAttemptAt: new Date().toISOString(),
    }
  };

  await customObjectsApi.patchNamespacedCustomObjectStatus(
    CRD_GROUP,
    CRD_VERSION,
    namespace,
    CRD_PLURAL,
    name,
    patch,
    undefined,
    undefined,
    undefined,
    { headers: { 'Content-Type': 'application/merge-patch+json' } },
  );

  log('warn', AGENT, 'Circuit breaker FIRED — incident marked escalated', {
    namespace,
    resourceName,
    limit: CIRCUIT_BREAKER_LIMIT,
  });
}

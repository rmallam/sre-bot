/**
 * Console BFF — namespace-scoped response filtering and mutation guards.
 */

import type { ConsoleUser } from '../../../shared/src/console-auth.js';
import {
  assertNamespaceAccess,
  filterByNamespaceAccess,
  NamespaceAccessDeniedError,
} from '../../../shared/src/namespace-rbac.js';

export function filterApprovalsResponse(
  user: ConsoleUser,
  body: { pending?: number; approvals?: Array<{ namespace?: string }> }
): { pending: number; approvals: Array<{ namespace?: string }> } {
  const approvals = filterByNamespaceAccess(user, body.approvals ?? [], (a) => a.namespace);
  return {
    pending: approvals.filter((a) => (a as { status?: string }).status === 'PENDING').length,
    approvals,
  };
}

export function filterRunsResponse(
  user: ConsoleUser,
  body: { runs?: Array<{ namespace?: string }> }
): { runs: Array<{ namespace?: string }> } {
  return {
    runs: filterByNamespaceAccess(user, body.runs ?? [], (r) => r.namespace),
  };
}

export function filterGroupedRunsResponse(
  user: ConsoleUser,
  body: { groups?: Array<{ namespace?: string; runs?: Array<{ namespace?: string }> }> }
): typeof body {
  const groups = filterByNamespaceAccess(user, body.groups ?? [], (g) => g.namespace).map(
    (g) => ({
      ...g,
      runs: filterByNamespaceAccess(user, g.runs ?? [], (r) => r.namespace),
    })
  );
  return { groups };
}

export function guardNamespace(user: ConsoleUser, namespace: string | undefined): void {
  assertNamespaceAccess(user, namespace);
}

export function namespaceAccessErrorResponse(err: unknown): { status: number; body: object } {
  if (err instanceof NamespaceAccessDeniedError) {
    return { status: 403, body: { error: err.message, code: 'namespace_forbidden' } };
  }
  return { status: 500, body: { error: String(err) } };
}

async function fetchApprovalNamespace(
  hilUrl: string,
  incidentId: string,
  proxyJson: (url: string, init?: RequestInit) => Promise<Response>
): Promise<string | undefined> {
  const r = await proxyJson(`${hilUrl}/api/approvals`);
  if (!r.ok) return undefined;
  const data = (await r.json()) as {
    approvals?: Array<{ incidentId: string; namespace?: string }>;
  };
  return data.approvals?.find((a) => a.incidentId === incidentId)?.namespace;
}

export async function guardApprovalMutation(
  user: ConsoleUser,
  incidentId: string,
  hilUrl: string,
  proxyJson: (url: string, init?: RequestInit) => Promise<Response>
): Promise<void> {
  const ns = await fetchApprovalNamespace(hilUrl, incidentId, proxyJson);
  guardNamespace(user, ns);
}

async function fetchRunNamespace(
  orchestratorUrl: string,
  runId: string,
  proxyJson: (url: string, init?: RequestInit) => Promise<Response>
): Promise<string | undefined> {
  const r = await proxyJson(`${orchestratorUrl}/runs/${encodeURIComponent(runId)}`);
  if (!r.ok) return undefined;
  const data = (await r.json()) as { namespace?: string; metadata?: { request?: { namespace?: string } } };
  return data.namespace ?? (data.metadata?.request as { namespace?: string } | undefined)?.namespace;
}

export async function guardRunMutation(
  user: ConsoleUser,
  runId: string,
  orchestratorUrl: string,
  proxyJson: (url: string, init?: RequestInit) => Promise<Response>
): Promise<void> {
  const ns = await fetchRunNamespace(orchestratorUrl, runId, proxyJson);
  guardNamespace(user, ns);
}

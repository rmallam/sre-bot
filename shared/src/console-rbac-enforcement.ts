/**
 * Secondary namespace RBAC enforcement for hil-agent when called from console BFF.
 */

import { canAccessNamespace, type ConsoleUser } from './namespace-rbac.js';

export const CONSOLE_NAMESPACES_HEADER = 'x-sre-console-namespaces';
export const CONSOLE_USER_HEADER = 'x-sre-console-user';

export function hilEnforceConsoleRbac(): boolean {
  const raw = process.env['HIL_ENFORCE_CONSOLE_RBAC'];
  return raw?.toLowerCase() === 'true' || raw === '1';
}

export function consoleRbacHeaders(user: ConsoleUser): Record<string, string> {
  return {
    [CONSOLE_NAMESPACES_HEADER]: JSON.stringify(user.allowedNamespaces),
    [CONSOLE_USER_HEADER]: user.userId,
  };
}

function parseNamespacesHeader(
  headers: Record<string, string | string[] | undefined>
): string[] | undefined {
  const raw = headers[CONSOLE_NAMESPACES_HEADER];
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (!val?.trim()) return undefined;
  try {
    const parsed = JSON.parse(val) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    return val.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
}

/** Returns true when the mutation is allowed for the target namespace. */
export function hilNamespaceMutationAllowed(
  headers: Record<string, string | string[] | undefined>,
  namespace: string | undefined,
  platform: string
): boolean {
  if (!hilEnforceConsoleRbac()) return true;
  if (platform === 'telegram' || platform === 'slack') return true;

  const allowed = parseNamespacesHeader(headers);
  if (!allowed?.length) return false;

  const user: ConsoleUser = {
    userId: String(headers[CONSOLE_USER_HEADER] ?? 'unknown'),
    groups: [],
    allowedNamespaces: allowed,
  };
  return canAccessNamespace(user, namespace);
}

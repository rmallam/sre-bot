/**
 * CON-2 — Map OIDC groups to allowed Kubernetes namespaces for console RBAC.
 */

export interface ConsoleUser {
  userId: string;
  email?: string;
  name?: string;
  groups: string[];
  /** '*' grants all namespaces. Empty = no namespace access. */
  allowedNamespaces: string[];
}

const WILDCARD = '*';

function envJson<T>(key: string): T | undefined {
  const raw = process.env[key];
  if (!raw?.trim()) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** group name → namespace list. Example: {"team-a":["ns-a","ns-b"],"admins":["*"]} */
export function parseNamespaceRbacMap(): Record<string, string[]> {
  return (
    envJson<Record<string, string[]>>('CONSOLE_NAMESPACE_RBAC') ??
    envJson<Record<string, string[]>>('OIDC_NAMESPACE_RBAC') ??
    {}
  );
}

export function resolveAllowedNamespaces(groups: string[]): string[] {
  const map = parseNamespaceRbacMap();
  const allowed = new Set<string>();
  for (const group of groups) {
    const nsList = map[group];
    if (!nsList?.length) continue;
    for (const ns of nsList) {
      allowed.add(ns.trim());
    }
  }
  if (allowed.has(WILDCARD)) return [WILDCARD];
  return [...allowed];
}

export function hasGlobalNamespaceAccess(user: ConsoleUser): boolean {
  return user.allowedNamespaces.includes(WILDCARD);
}

export function canAccessNamespace(user: ConsoleUser, namespace: string | undefined): boolean {
  if (!namespace?.trim()) return hasGlobalNamespaceAccess(user);
  if (hasGlobalNamespaceAccess(user)) return true;
  return user.allowedNamespaces.includes(namespace.trim());
}

export function filterByNamespaceAccess<T>(
  user: ConsoleUser,
  items: T[],
  getNamespace: (item: T) => string | undefined
): T[] {
  if (hasGlobalNamespaceAccess(user)) return items;
  return items.filter((item) => canAccessNamespace(user, getNamespace(item)));
}

export function assertNamespaceAccess(user: ConsoleUser, namespace: string | undefined): void {
  if (canAccessNamespace(user, namespace)) return;
  const ns = namespace?.trim() || '(unknown)';
  throw new NamespaceAccessDeniedError(ns, user.userId);
}

export class NamespaceAccessDeniedError extends Error {
  readonly statusCode = 403;
  constructor(namespace: string, userId: string) {
    super(`Access denied: user ${userId} cannot access namespace ${namespace}`);
    this.name = 'NamespaceAccessDeniedError';
  }
}

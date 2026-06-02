/**
 * Namespace scope parsing — avoid treating "any" / "all" as literal namespace names.
 */

const ALL_NAMESPACES_PATTERNS = [
  /\bin\s+(?:any|all)\s+namespaces?\b/i,
  /\bacross\s+(?:all\s+)?namespaces?\b/i,
  /\bin\s+every\s+namespace\b/i,
  /\banywhere\s+(?:in\s+(?:the\s+)?cluster)?\b/i,
  /\bcluster[\s-]?wide\b/i,
];

const META_NAMESPACE_TOKENS = new Set(['any', 'all', 'every', 'each']);

export function isAllNamespacesScope(text: string): boolean {
  return ALL_NAMESPACES_PATTERNS.some((re) => re.test(text));
}

/** True when token is a scope qualifier, not a real namespace name. */
export function isMetaNamespaceToken(token: string, fullText?: string): boolean {
  const lower = token.toLowerCase();
  if (fullText && isAllNamespacesScope(fullText)) return true;
  return META_NAMESPACE_TOKENS.has(lower);
}

export const ALL_NAMESPACES = '_all';

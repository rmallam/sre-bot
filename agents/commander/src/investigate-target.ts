/**
 * Infer Kubernetes namespace vs workload from natural-language fix/investigate requests.
 */

import { isMetaNamespaceToken } from '../../../shared/src/namespace-scope.js';

/** Names like frappe-operator-system, kube-system, cert-manager-operator. */
export function looksLikeKubernetesNamespace(token: string): boolean {
  const t = token.trim().toLowerCase();
  if (!t || t.length < 3 || isMetaNamespaceToken(t)) return false;
  if (t === 'default' || t === 'kube-system' || t === 'kube-public') return true;
  return /-(?:system|operator-system|operator|infra|platform)$/.test(t);
}

/** Extract namespace when user names an operator/system namespace without saying "namespace". */
export function extractOperatorNamespaceHint(text: string): string | undefined {
  const slash = text.match(/\b([\w-]+)\/([\w-]+)\b/);
  if (slash?.[1] && looksLikeKubernetesNamespace(slash[1])) {
    return slash[1].toLowerCase();
  }

  const explicit = text.match(
    /\b(?:fix|repair|remediate|patch|update|investigate|check|deploy\s+to)\s+(?:the\s+)?([\w-]+-(?:system|operator-system|operator))\b/i
  );
  if (explicit?.[1] && looksLikeKubernetesNamespace(explicit[1])) {
    return explicit[1].toLowerCase();
  }

  const token = text.match(/\b([\w-]+-(?:system|operator-system))\b/i);
  if (token?.[1] && looksLikeKubernetesNamespace(token[1])) {
    return token[1].toLowerCase();
  }

  return undefined;
}

/** Derive a deployment name hint from a namespace (frappe-operator-system → frappe-operator). */
export function workloadHintFromNamespace(namespace: string): string {
  const ns = namespace.trim().toLowerCase();
  if (ns.endsWith('-operator-system')) {
    return ns.replace(/-operator-system$/, '-operator');
  }
  if (ns.endsWith('-system')) {
    return ns.replace(/-system$/, '');
  }
  return ns;
}

/** Build container image ref from ghcr/docker shorthand in user text. */
export function extractContainerImageHint(text: string, workloadHint?: string): string | null {
  const t = text.trim();
  const full = t.match(/\b([a-z0-9.-]+\.[a-z]{2,}\/[^\s`"']+:[^\s`"']+)/i);
  if (full?.[1]) return full[1];

  const setImage =
    t.match(/\b(?:set|use|change|update)\s+(?:the\s+)?(?:image|impage)\s+(?:to\s+)?(?:with\s+)?(?:a\s+)?[`'"]?([^\s`"']+)[`'"]?/i) ??
    t.match(/\bimage\s*[:=]\s*[`'"]?([^\s`"']+)[`'"]?/i);
  if (setImage?.[1] && setImage[1].includes(':')) return setImage[1];

  const tagMatch = t.match(/\b([\w][\w.-]*:[\w][\w.-]*)\b/);
  if (tagMatch?.[1]) {
    const tag = tagMatch[1];
    if (/\bghcr\b/i.test(t)) {
      const org = t.match(/\b(vyogotech|[\w-]+)\s+ghcr\b/i)?.[1] ?? (/\bvyogotech\b/i.test(t) ? 'vyogotech' : null);
      if (org && !tag.includes('/')) return `ghcr.io/${org}/${tag}`;
      return `ghcr.io/${tag}`;
    }
    return tag;
  }

  if (/\bghcr\b/i.test(t) && /\blatest\b/i.test(t)) {
    const org =
      t.match(/\b(vyogotech|[\w-]+)\s+ghcr\b/i)?.[1] ??
      (/\bvyogotech\b/i.test(t) ? 'vyogotech' : null);
    if (org) {
      const repo = (workloadHint ?? 'app')
        .replace(/-controller-manager$/, '')
        .replace(/-system$/, '')
        .replace(/-operator-system$/, '-operator');
      return `ghcr.io/${org}/${repo}:latest`;
    }
  }

  return null;
}

/** User message likely asks to change or specify a container image. */
export function looksLikeImageRemediation(text: string): boolean {
  return (
    /\b(update|change|set|use|switch|fix|pull|deploy)\s+(?:the\s+)?(?:image|impage|container|tag)\b/i.test(
      text
    ) ||
    /\b(ghcr\.io|ghcr\b|docker\.io|gcr\.io|ecr\.|acr\.|registry\.)/i.test(text) ||
    /\b(?:latest|stable|v?\d+\.\d+[\w.-]*)\s+(?:image|tag|version)\b/i.test(text) ||
    /\bimage\s*[:=]/i.test(text)
  );
}

/** Validate and normalize a container image reference from LLM or user text. */
export function normalizeContainerImageRef(raw: string): string | null {
  const t = raw.trim().replace(/^['"`]+|['"`]+$/g, '');
  if (!t || t.length > 512) return null;
  if (/^set\s+image\s+to\s+/i.test(t)) {
    return normalizeContainerImageRef(t.replace(/^set\s+image\s+to\s+/i, ''));
  }
  if (/^[a-z0-9.-]+\.[a-z]{2,}\/[^\s`"']+:[^\s`"']+$/i.test(t)) return t;
  if (/^[\w][\w./-]*:[\w][\w./-]*$/.test(t) && !t.startsWith('http')) return t;
  return null;
}

export interface ResolveOperatorSuggestionInput {
  text: string;
  workloadHint?: string;
  llmContainerImage?: string;
  llmOperatorSuggestion?: string;
}

/** Prefer LLM-normalized image ref; fall back to rule-based parsing. */
export function resolveOperatorSuggestion(input: ResolveOperatorSuggestionInput): string | undefined {
  const fromLlmImage = input.llmContainerImage
    ? normalizeContainerImageRef(input.llmContainerImage)
    : null;
  if (fromLlmImage) return `set image to ${fromLlmImage}`;

  if (input.llmOperatorSuggestion) {
    const fromOp =
      normalizeContainerImageRef(input.llmOperatorSuggestion) ??
      (() => {
        const m = input.llmOperatorSuggestion!.match(/\bset\s+image\s+to\s+(.+)/i);
        return m?.[1] ? normalizeContainerImageRef(m[1]) : null;
      })();
    if (fromOp) return `set image to ${fromOp}`;
  }

  return operatorSuggestionFromMessage(input.text, input.workloadHint);
}

export function operatorSuggestionFromMessage(text: string, workloadHint?: string): string | undefined {
  const image = extractContainerImageHint(text, workloadHint);
  return image ? `set image to ${image}` : undefined;
}

/** Prefer explicit namespace; avoid default when message names an operator namespace. */
export function resolveInvestigateNamespace(
  parsedNamespace: string | undefined,
  rawMessage: string
): string | undefined {
  const opNs = extractOperatorNamespaceHint(rawMessage);
  if (opNs) return opNs;
  if (parsedNamespace && parsedNamespace !== '_all' && parsedNamespace !== 'default') {
    return parsedNamespace;
  }
  return undefined;
}

export function resolveWorkloadHintForMessage(
  parsed: { workloadHint?: string; resourceName?: string; namespace?: string },
  rawMessage: string
): string {
  const fromParser = parsed.workloadHint?.trim();
  if (fromParser && !looksLikeKubernetesNamespace(fromParser)) {
    return fromParser;
  }

  const explicit = rawMessage.match(
    /\b(?:fix|repair|remediate|patch|update|change|for|on)\s+(?:the\s+)?([a-z0-9][\w.-]*)\b/i
  );
  if (explicit?.[1] && !looksLikeKubernetesNamespace(explicit[1])) {
    return explicit[1];
  }

  const opNs = extractOperatorNamespaceHint(rawMessage) ?? resolveInvestigateNamespace(parsed.namespace, rawMessage);
  if (opNs) return workloadHintFromNamespace(opNs);

  if (parsed.resourceName && !parsed.resourceName.startsWith('_')) {
    return parsed.resourceName;
  }

  return '';
}

/**
 * Order multi-document Kubernetes manifests for safe apply (CRDs before workloads).
 */

export function splitKubernetesDocuments(yaml: string): string[] {
  return yaml
    .split(/^---\s*$/m)
    .map((d) => d.trim())
    .filter(Boolean);
}

export function isCrdDocument(docYaml: string): boolean {
  return /kind:\s*CustomResourceDefinition\b/i.test(docYaml);
}

export function isClusterScopedDocument(docYaml: string): boolean {
  if (isCrdDocument(docYaml)) return true;
  return /^\s*kind:\s*(ClusterRole|ClusterRoleBinding|ValidatingWebhookConfiguration|MutatingWebhookConfiguration|Namespace)\b/im.test(
    docYaml
  );
}

/** CRDs and cluster-scoped RBAC first, then namespaced resources. */
export function orderDocumentsForApply(docs: string[]): string[] {
  const crds: string[] = [];
  const clusterScoped: string[] = [];
  const namespaced: string[] = [];

  for (const doc of docs) {
    if (isCrdDocument(doc)) {
      crds.push(doc);
    } else if (/^\s*kind:\s*(ClusterRole|ClusterRoleBinding|ValidatingWebhookConfiguration|MutatingWebhookConfiguration)\b/im.test(doc)) {
      clusterScoped.push(doc);
    } else {
      namespaced.push(doc);
    }
  }

  return [...crds, ...clusterScoped, ...namespaced];
}

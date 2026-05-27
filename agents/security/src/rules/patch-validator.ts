import type { JsonPatchOp } from '../../../../shared/src/types.js';

const DENIED_KIND_PATHS = ['/kind'];
const DENIED_CLUSTER_KINDS = ['ClusterRole', 'ClusterRoleBinding', 'Namespace'];

export function validatePatch(
  patch: JsonPatchOp[],
  manifestContent?: string
): { allowed: boolean; reason?: string } {
  for (const op of patch) {
    if (op.path.includes('ClusterRole') || op.path.includes('Namespace')) {
      return { allowed: false, reason: `Denied patch path: ${op.path}` };
    }
    if (op.op === 'remove' && op.path.includes('/spec/replicas')) {
      return { allowed: false, reason: 'Cannot remove replica count' };
    }
    if (op.value && typeof op.value === 'object') {
      const kind = (op.value as { kind?: string }).kind;
      if (kind && DENIED_CLUSTER_KINDS.includes(kind)) {
        return { allowed: false, reason: `Denied kind in patch value: ${kind}` };
      }
    }
  }

  if (manifestContent) {
    for (const kind of DENIED_CLUSTER_KINDS) {
      if (manifestContent.includes(`kind: ${kind}`)) {
        return { allowed: false, reason: `Manifest contains denied kind ${kind}` };
      }
    }
  }

  for (const p of DENIED_KIND_PATHS) {
    if (patch.some((op) => op.path === p && op.op === 'replace')) {
      return { allowed: false, reason: `Denied modification of ${p}` };
    }
  }

  return { allowed: true };
}

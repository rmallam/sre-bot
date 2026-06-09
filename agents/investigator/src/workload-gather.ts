/**
 * Resolve pod + controller context before gatherPodFacts.
 */

import type { ResourceKind } from '../../../shared/src/types.js';
import { gatherPodFacts } from './k8s-facts.js';
import { resolvePodForWorkload } from './workload-resolve.js';

export interface WorkloadGatherTarget {
  podName: string;
  resourceName: string;
  resourceKind: ResourceKind;
}

/** Normalize pod vs controller names for fact gathering. */
export async function resolveWorkloadGatherTarget(
  namespace: string,
  resourceName: string,
  resourceKind: ResourceKind,
  incidentId: string
): Promise<WorkloadGatherTarget> {
  // Pod-shaped name on StatefulSet workload (e.g. rabbit-rabbitmq-0)
  if (resourceKind !== 'Pod' && /-\d+$/.test(resourceName)) {
    const base = resourceName.replace(/-\d+$/, '');
    const pod = await resolvePodForWorkload(namespace, resourceName, 'Pod', incidentId);
    if (pod) {
      return {
        podName: pod,
        resourceName: base,
        resourceKind,
      };
    }
  }

  const podName =
    (await resolvePodForWorkload(namespace, resourceName, resourceKind, incidentId)) ??
    resourceName;

  return { podName, resourceName, resourceKind };
}

export async function gatherWorkloadPodFacts(
  namespace: string,
  resourceName: string,
  resourceKind: ResourceKind,
  incidentId: string
) {
  const target = await resolveWorkloadGatherTarget(
    namespace,
    resourceName,
    resourceKind,
    incidentId
  );
  return gatherPodFacts(
    namespace,
    target.podName,
    target.resourceName,
    target.resourceKind,
    incidentId
  );
}

import assert from 'node:assert/strict';
import { scoreWorkloadHint } from '../../investigator/src/workload-resolve.js';
import type { WorkloadCandidate } from '../src/investigate-choice.js';

// Mirror commander auto-pick logic for image remediation.
function deploymentControllers(candidates: WorkloadCandidate[]): WorkloadCandidate[] {
  return candidates.filter(
    (c) => c.resourceKind === 'Deployment' || c.resourceKind === 'StatefulSet'
  );
}

function bestControllerForHint(
  controllers: WorkloadCandidate[],
  hint: string
): WorkloadCandidate | undefined {
  if (controllers.length === 0) return undefined;
  const h = hint.trim().toLowerCase();
  const exact = controllers.find((c) => c.resourceName.toLowerCase() === h);
  if (exact) return exact;
  const related = controllers.filter((c) => {
    const n = c.resourceName.toLowerCase();
    return n.startsWith(h) || h.startsWith(n) || n.includes(h) || h.includes(n);
  });
  if (related.length === 1) return related[0];
  if (related.length > 1) {
    return [...related].sort((a, b) => b.score - a.score)[0];
  }
  return [...controllers].sort((a, b) => b.score - a.score)[0];
}

const hint = 'frappe-operator-controller';
const deployment = {
  namespace: 'frappe-operator-system',
  resourceKind: 'Deployment' as const,
  resourceName: 'frappe-operator-controller-manager',
  label: 'frappe-operator-system/frappe-operator-controller-manager (0/1 ready)',
  score: scoreWorkloadHint(hint, 'frappe-operator-controller-manager'),
};
const pod = {
  namespace: 'frappe-operator-system',
  resourceKind: 'Pod' as const,
  resourceName: 'frappe-operator-controller-manager-7d4f9c8b-xk2lm',
  podName: 'frappe-operator-controller-manager-7d4f9c8b-xk2lm',
  label: 'frappe-operator-system/pod frappe-operator-controller-manager-7d4f9c8b-xk2lm',
  score: Math.min(100, scoreWorkloadHint(hint, 'frappe-operator-controller-manager-7d4f9c8b-xk2lm') + 5),
};

assert.equal(deployment.score, 80);
assert.ok(pod.score >= deployment.score, 'pod used to outrank deployment before filtering');

const pick = bestControllerForHint(deploymentControllers([deployment, pod]), hint);
assert.ok(pick);
assert.equal(pick!.resourceKind, 'Deployment');
assert.equal(pick!.resourceName, 'frappe-operator-controller-manager');

console.log('investigate-choice.test.ts: ok');

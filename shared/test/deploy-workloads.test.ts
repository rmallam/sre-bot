import assert from 'node:assert/strict';
import {
  flattenDeployWorkloads,
  mergeDeployReleaseTargets,
  type DeployReleaseTargets,
} from '../src/deploy-workloads.js';
import { describe, test } from 'vitest';

describe('deploy-workloads', () => {
  test('legacy assertions', () => {
    const frappeTargets: DeployReleaseTargets = {
      releaseName: 'frappe-operator',
      namespace: 'frappe-operator-system',
      discoveryMethod: 'helm-instance-label',
      discoveredAt: '2026-01-01T00:00:00.000Z',
      workloads: [
        {
          namespace: 'frappe-operator-system',
          resourceKind: 'Deployment',
          resourceName: 'frappe-operator-controller-manager',
        },
        {
          namespace: 'frappe-operator-system',
          resourceKind: 'Deployment',
          resourceName: 'frappe-operator-mariadb-operator',
        },
      ],
    };

    assert.equal(flattenDeployWorkloads(frappeTargets).length, 2);

    const merged = mergeDeployReleaseTargets(frappeTargets, {
      ...frappeTargets,
      workloads: [
        {
          namespace: 'frappe-operator-system',
          resourceKind: 'Deployment',
          resourceName: 'frappe-operator-controller-manager',
        },
      ],
    });
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.workloads.length, 1);

    const stack = mergeDeployReleaseTargets(undefined, frappeTargets);
    const redisTargets: DeployReleaseTargets = {
      releaseName: 'redis',
      namespace: 'redis',
      discoveryMethod: 'exact',
      discoveredAt: '2026-01-01T00:00:00.000Z',
      workloads: [{ namespace: 'redis', resourceKind: 'Deployment', resourceName: 'redis' }],
    };
    const both = mergeDeployReleaseTargets(stack, redisTargets);
    assert.equal(both.length, 2);
    assert.equal(flattenDeployWorkloads(both).length, 3);
  });
});

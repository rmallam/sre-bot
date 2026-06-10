import assert from 'node:assert/strict';
import { approvalStore } from '../src/store.js';
import type { ApprovalRequest } from '../../../shared/src/types.js';
import { describe, test } from 'vitest';

describe('store-dedupe', () => {
  test('legacy assertions', () => {
    function sample(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
      return {
        incidentId: 'inc-a',
        runId: 'run-x',
        triggeredBy: 'user',
        triggeredAt: new Date().toISOString(),
        namespace: 'simple',
        resourceKind: 'Deployment',
        resourceName: 'app',
        mode: 'pre-deploy',
        plan: {
          action: 'helm_deploy',
          severity: 'low',
          rootCause: 'x',
          reasoning: 'y',
          proposedPatch: [],
          targetManifestPath: 'd.yaml',
          commitMessage: 'c',
          rollbackSafe: true,
        },
        attemptNumber: 1,
        circuitBreakerLimit: 5,
        escalated: false,
        ...overrides,
      };
    }

    const first = approvalStore.mergeOrCreate(sample());
    assert.equal(first.action, 'created');

    const dup = approvalStore.mergeOrCreate(sample({ attemptNumber: 2 }));
    assert.equal(dup.action, 'duplicate');

    const updated = approvalStore.mergeOrCreate(
      sample({ plan: { ...sample().plan, action: 'restart' } })
    );
    assert.equal(updated.action, 'updated');
    assert.equal(updated.incidentId, 'inc-a');
  });
});

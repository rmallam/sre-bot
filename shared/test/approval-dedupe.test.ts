import assert from 'node:assert/strict';
import { approvalNotifyFingerprint } from '../src/approval-dedupe.js';
import type { ApprovalRequest } from '../src/types.js';
import { describe, test } from 'vitest';

describe('approval-dedupe', () => {
  test('legacy assertions', () => {
    const base: ApprovalRequest = {
      incidentId: 'inc-1',
      runId: 'run-1',
      triggeredBy: 'user',
      triggeredAt: new Date().toISOString(),
      namespace: 'simple',
      resourceKind: 'Deployment',
      resourceName: 'my-app',
      mode: 'pre-deploy',
      plan: {
        action: 'helm_deploy',
        severity: 'medium',
        rootCause: 'test',
        reasoning: 'test',
        proposedPatch: [],
        targetManifestPath: 'deploy/deployment.yaml',
        commitMessage: 'fix',
        rollbackSafe: true,
      },
      attemptNumber: 1,
      circuitBreakerLimit: 5,
      escalated: false,
    };

    assert.equal(approvalNotifyFingerprint(base), approvalNotifyFingerprint({ ...base, attemptNumber: 2 }));

    const restart = {
      ...base,
      plan: { ...base.plan, action: 'restart' as const },
    };
    assert.notEqual(approvalNotifyFingerprint(base), approvalNotifyFingerprint(restart));
  });
});

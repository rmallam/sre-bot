import assert from 'node:assert/strict';
import { isRolloutInProgress, isTerminalWorkloadFailure, isTransientImagePull } from '../src/rollout-status.js';
import { classifyRolloutDetail, inferRemediationWaitContext } from '../src/rollout-phase.js';
import { decideWaitContinuation, shouldHoldForOperator } from '../src/remediation-wait-strategy.js';
import { waitForWorkloadReady } from '../src/workload-readiness-wait.js';
import { decideDiagnoseVerifyRecovery } from '../src/diagnose-verify-recovery.js';
import { describe, test } from 'vitest';

describe('workload-readiness-wait', () => {
  test('legacy assertions', async () => {
    assert.equal(isTerminalWorkloadFailure('ImagePullBackOff pulling image'), true);
    assert.equal(isTerminalWorkloadFailure('ErrImagePull failed to pull'), false);
    assert.equal(isTransientImagePull('ErrImagePull: manifest unknown'), true);

    assert.equal(classifyRolloutDetail('ContainerCreating: Pulling image "ghcr.io/app:v2"'), 'pulling_image');
    assert.equal(classifyRolloutDetail('frappe running, readiness probe not passing yet'), 'probe_warming');

    const pullWait = decideWaitContinuation(
      {
        healthy: false,
        readyReplicas: 0,
        desiredReplicas: 2,
        rolloutPhase: 'pulling_image',
        waitDetail: '2 pod(s) pulling image',
        message: '2 pod(s) pulling image',
        rolloutInProgress: true,
      },
      inferRemediationWaitContext('git_patch', { imagePatch: true })
    );
    assert.equal(pullWait.keepWaiting, true);
    assert.equal(pullWait.phase, 'pulling_image');

    assert.equal(
      shouldHoldForOperator({
        healthy: false,
        rolloutPhase: 'pulling_image',
        rolloutInProgress: true,
        message: 'pulling',
      }),
      true
    );

    assert.equal(
      isRolloutInProgress({ readyReplicas: 0, desiredReplicas: 2, updatedReplicas: 1 }),
      true
    );

    let polls = 0;
    const result = await waitForWorkloadReady({
      namespace: 'ns',
      resourceName: 'app',
      incidentId: 'inc-1',
      remediationAction: 'git_patch',
      afterImagePatch: true,
      initialDelayMs: 5,
      fetchVerify: async () => {
        polls += 1;
        if (polls < 3) {
          return {
            healthy: false,
            readyReplicas: 0,
            desiredReplicas: 2,
            updatedReplicas: 1,
            rolloutPhase: 'pulling_image',
            waitDetail: '2 pod(s) pulling image ghcr.io/app:v2',
            rolloutInProgress: true,
            message: '2 pod(s) pulling image ghcr.io/app:v2',
          };
        }
        return {
          healthy: true,
          readyReplicas: 2,
          desiredReplicas: 2,
          updatedReplicas: 2,
          rolloutPhase: 'ready',
          message: 'Deployment app ready 2/2',
        };
      },
    });

    assert.equal(result.healthy, true);
    assert.ok(polls >= 3);

    const recovery = decideDiagnoseVerifyRecovery('still broken', 'frappe-operator', 'git_patch');
    assert.equal(recovery.status, 'ask_confirmation');
  });
});

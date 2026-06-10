import assert from 'node:assert/strict';
import { evaluateDeploySourceGate } from '../../agents/orchestrator/src/deploy-source-gate.js';
import type { StartRunRequest } from '../src/types.js';
import { describe, test } from 'vitest';

describe('deploy-source-gate', () => {
  test('legacy assertions', async () => {
    const baseRequest: StartRunRequest = {
      incidentId: 'inc-1',
      triggeredBy: 'commander',
      triggeredAt: new Date().toISOString(),
      namespace: 'prod',
      resourceKind: 'Deployment',
      resourceName: 'pay',
      mode: 'diagnose',
    };

    const blocked = await evaluateDeploySourceGate({
      mode: 'diagnose',
      namespace: 'prod',
      resourceKind: 'Deployment',
      resourceName: 'pay',
      request: baseRequest,
      facts: {
        ...baseRequest,
        podSpec: {},
        containerStatuses: [],
        resourceLimits: {},
        recentEvents: [],
        currentLogs: '',
        previousLogs: '',
        deployProvenance: {
          method: 'helm',
          confidence: 'medium',
          source: 'cluster-labels',
          fixSurface: 'gitops-repo',
          missingFields: ['sourceRepo', 'chartPath'],
          helmRelease: { name: 'pay', namespace: 'prod' },
        },
      },
    });
    assert.equal(blocked.blocked, true);
    assert.ok(blocked.prompt?.includes('Helm release'));

    const allowed = await evaluateDeploySourceGate({
      mode: 'diagnose',
      namespace: 'prod',
      resourceKind: 'Deployment',
      resourceName: 'pay',
      request: {
        ...baseRequest,
        deployProvenance: {
          sourceRepo: 'github.com/acme/pay',
          chartPath: 'helm/pay',
          gitRef: 'main',
          method: 'helm',
        },
      },
      facts: {
        ...baseRequest,
        podSpec: {},
        containerStatuses: [],
        resourceLimits: {},
        recentEvents: [],
        currentLogs: '',
        previousLogs: '',
      },
    });
    assert.equal(allowed.blocked, false);
  });
});

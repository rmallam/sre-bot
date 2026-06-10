import assert from 'node:assert/strict';
import {
  extractEventFromInvestigateText,
  buildEventInvestigation,
} from '../src/k8s-event-investigation.js';
import { describe, test } from 'vitest';

describe('k8s-event-investigation', () => {
  test('legacy assertions', () => {
    const extracted = extractEventFromInvestigateText(
      'investigate this • FailedNodeAllocatableEnforcement: Failed to update Node Allocatable Limits ["kubelet" "kubepods"]'
    );
    assert.ok(extracted);
    assert.equal(extracted!.reason, 'FailedNodeAllocatableEnforcement');
    assert.match(extracted!.message, /Allocatable Limits/);

    const healthy = buildEventInvestigation({
      reason: 'FailedNodeAllocatableEnforcement',
      message: extracted!.message,
      snapshot: {
        reachable: true,
        checkedAt: new Date().toISOString(),
        status: 'healthy',
        displayStatus: 'healthy',
        statusSummary: 'ok',
        eventWindowMinutes: 15,
        nodes: { total: 1, ready: 1, notReady: 0, items: [] },
        pods: { total: 10, running: 10, pending: 0, failed: 0, problematic: 0, issues: [] },
        deployments: { total: 5, unhealthy: 0, items: [] },
        warningEvents: [],
      },
    });
    assert.equal(healthy.severity, 'benign');
    assert.equal(healthy.clusterHealthy, true);
    assert.match(healthy.recommendation, /No action needed/i);
  });
});

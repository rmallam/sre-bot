import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  buildAlertRunGroups,
  correlationKeyFromLabels,
  groupParsedAlerts,
} from '../src/alert-correlation.js';

describe('alert-correlation', () => {
  test('correlationKeyFromLabels prefers dependency labels', () => {
    assert.equal(
      correlationKeyFromLabels({ dependency: 'checkout-postgres', namespace: 'checkout' }),
      'dependency:checkout-postgres'
    );
  });

  test('correlationKeyFromLabels prefers graph binding', () => {
    assert.equal(
      correlationKeyFromLabels({ 'sre-graph-binding': 'graph-dep:postgres+redis' }),
      'graph-dep:postgres+redis'
    );
  });

  test('groupParsedAlerts merges workloads sharing dependency', () => {
    const groups = groupParsedAlerts(
      [
        {
          namespace: 'checkout',
          resourceName: 'payments-api',
          resourceKind: 'Deployment',
          labels: { dependency: 'shared-db', alertname: 'HighErrorRate' },
          annotations: {},
          fingerprint: 'a',
          alertname: 'HighErrorRate',
          summary: 'payments errors',
        },
        {
          namespace: 'checkout',
          resourceName: 'orders-api',
          resourceKind: 'Deployment',
          labels: { dependency: 'shared-db', alertname: 'HighErrorRate' },
          annotations: {},
          fingerprint: 'b',
          alertname: 'HighErrorRate',
          summary: 'orders errors',
        },
      ],
      { minGroupSize: 2 }
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.affectedWorkloads.length, 2);
    assert.equal(groups[0]!.correlationKey, 'dependency:shared-db');
  });

  test('buildAlertRunGroups keeps uncorrelated alerts as singles', () => {
    const groups = buildAlertRunGroups([
      {
        namespace: 'a',
        resourceName: 'svc-a',
        resourceKind: 'Deployment',
        labels: { namespace: 'a', deployment: 'svc-a', alertname: 'PodCrash' },
        annotations: {},
        fingerprint: '1',
        alertname: 'PodCrash',
        summary: 'crash',
      },
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.affectedWorkloads.length, 1);
  });
});

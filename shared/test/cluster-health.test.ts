import assert from 'node:assert/strict';
import {
  classifyPodIssue,
  deriveClusterStatus,
  deriveDisplayStatus,
  buildStatusSummary,
  isRecentEvent,
  filterRecentWarningEvents,
} from '../src/cluster-health.js';

assert.equal(
  classifyPodIssue({
    namespace: 'redis-test',
    name: 'rabbit-0',
    phase: 'Pending',
    containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } }],
  })?.reason,
  'ImagePullBackOff'
);

assert.equal(
  classifyPodIssue({
    namespace: 'default',
    name: 'ok',
    phase: 'Running',
    containerStatuses: [{ state: {} }],
  }),
  null
);

assert.equal(
  classifyPodIssue({
    namespace: 'default',
    name: 'pending',
    phase: 'Pending',
  }),
  null
);

assert.equal(
  deriveClusterStatus({
    reachable: false,
    notReadyNodes: 0,
    unhealthyDeployments: 0,
    problematicPods: 0,
    warningEvents: 0,
  }),
  'unreachable'
);

assert.equal(
  deriveClusterStatus({
    reachable: true,
    notReadyNodes: 0,
    unhealthyDeployments: 0,
    problematicPods: 1,
    warningEvents: 0,
  }),
  'degraded'
);

assert.equal(
  deriveClusterStatus({
    reachable: true,
    notReadyNodes: 0,
    unhealthyDeployments: 0,
    problematicPods: 0,
    warningEvents: 0,
  }),
  'healthy'
);

assert.equal(
  deriveDisplayStatus({
    reachable: true,
    notReadyNodes: 0,
    unhealthyDeployments: 0,
    problematicPods: 0,
    warningEvents: 2,
  }),
  'degrading'
);

assert.equal(
  deriveDisplayStatus({
    reachable: true,
    notReadyNodes: 0,
    unhealthyDeployments: 1,
    problematicPods: 0,
    warningEvents: 0,
  }),
  'apps_failing'
);

assert.match(
  buildStatusSummary('degrading', {
    notReadyNodes: 0,
    unhealthyDeployments: 0,
    problematicPods: 0,
    warningEvents: 3,
    eventWindowMinutes: 15,
  }),
  /last 15m/
);

const now = Date.now();
assert.equal(isRecentEvent(new Date(now - 5 * 60_000).toISOString(), now, 15), true);
assert.equal(isRecentEvent(new Date(now - 60 * 60_000).toISOString(), now, 15), false);

assert.equal(
  filterRecentWarningEvents(
    [
      { lastTime: new Date(now - 2 * 60_000).toISOString() },
      { lastTime: new Date(now - 2 * 60 * 60_000).toISOString() },
    ],
    now,
    15
  ).length,
  1
);

console.log('cluster-health.test.ts: ok');

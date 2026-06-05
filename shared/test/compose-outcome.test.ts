import assert from 'node:assert/strict';
import { formatCommandOutcomeFallback } from '../src/compose-outcome-fallback.js';

const undeployKubectlOnly = formatCommandOutcomeFallback({
  kind: 'undeploy',
  ok: true,
  userHint: 'appache',
  payload: {
    releaseName: 'apache',
    namespace: 'default',
    found: { helmRelease: false, deployment: true, service: false, labeledResources: 0 },
    actions: [{ type: 'deployment_deleted' }],
    skipped: [{ type: 'helm', reason: 'not_present' }],
  },
});

assert.match(undeployKubectlOnly, /appache/i);
assert.match(undeployKubectlOnly, /apache/i);
assert.match(undeployKubectlOnly, /kubectl Deployment|plain kubectl/i);
assert.doesNotMatch(undeployKubectlOnly, /What I did:/i);

const notFound = formatCommandOutcomeFallback({
  kind: 'not_found',
  subject: 'appache',
  namespace: 'default',
});

assert.match(notFound, /couldn't find/i);
assert.match(notFound, /appache/i);

const unreachableCluster = formatCommandOutcomeFallback({
  kind: 'health',
  data: {
    label: 'the cluster',
    summary: 'Cannot connect to the Kubernetes API — the cluster may be stopped.',
    warnings: [],
    deployments: [],
    clusterReachable: false,
  },
});

assert.match(unreachableCluster, /can't reach/i);
assert.match(unreachableCluster, /cluster may be stopped/i);

console.log('compose-outcome.test.ts: ok');

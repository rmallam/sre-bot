import assert from 'node:assert/strict';
import { formatCommandOutcomeFallback } from '../src/compose-outcome-fallback.js';
import { describe, test } from 'vitest';

describe('compose-outcome', () => {
  test('legacy assertions', () => {
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

    const clusterGetPods = formatCommandOutcomeFallback({
      kind: 'cluster_get',
      data: {
        resource: 'pods',
        namespace: 'sre-bot-system',
        total: 2,
        shown: 2,
        text: [
          '📋 Pods in sre-bot-system (2)',
          '',
          '```',
          'NAME                                 READY    STATUS',
          'console-agent-abc                    1/1      Running',
          'commander-agent-def                  1/1      Running',
          '```',
        ].join('\n'),
      },
    });

    assert.match(clusterGetPods, /console-agent-abc/);
    assert.match(clusterGetPods, /commander-agent-def/);
    assert.doesNotMatch(clusterGetPods, /Say \*\*more detail\*\* for the full table/i);
  });
});

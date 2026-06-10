import assert from 'node:assert/strict';
import {
  clusterScopePlugin,
  namespaceScopePlugin,
  eventsPlugin,
  createDefaultRcaPlugins,
} from '../src/rca/plugins.js';
import { gatherAllRcaPointers } from '../src/rca/registry.js';
import type { RcaGatherContext } from '../src/rca/plugin.js';
import { describe, test } from 'vitest';

describe('rca-plugins', () => {
  test('legacy assertions', async () => {
    const baseCtx: RcaGatherContext = {
      incidentId: 'test-1',
      namespace: 'default',
      resourceName: '_cluster',
      podName: '_cluster',
      scope: 'cluster',
      k8sFacts: {
        clusterReachable: true,
        recentEvents: [{ reason: 'FailedScheduling', message: 'no nodes', count: 1, firstTime: '', lastTime: '', type: 'Warning' }],
        scopeHealth: {
          scope: 'cluster',
          nodeCount: 3,
          notReadyNodeCount: 1,
          unhealthyDeployments: [
            { namespace: 'app', name: 'api', ready: 1, desired: 3 },
          ],
        },
        currentLogs: 'Cluster overview',
      },
    };

    async function runClusterScope() {
      assert.equal(clusterScopePlugin.isApplicable(baseCtx), true);
      assert.equal(namespaceScopePlugin.isApplicable(baseCtx), false);
      const clusterResult = await clusterScopePlugin.gather(baseCtx);
      assert.ok(clusterResult?.pointer.title.includes('Cluster'));

      const eventsResult = await eventsPlugin.gather(baseCtx);
      assert.ok(eventsResult?.pointer.findings.length);

      const merged = await gatherAllRcaPointers(baseCtx, createDefaultRcaPlugins());
      assert.ok(merged.rcaPointers.length >= 2);
      assert.ok(merged.observabilitySummary.includes('[kubernetes]'));
    }

    async function runNamespaceScope() {
      const nsCtx: RcaGatherContext = {
        ...baseCtx,
        scope: 'namespace',
        resourceName: '_namespace',
        namespace: 'app',
        k8sFacts: {
          existingDeployments: ['api', 'worker'],
          scopeHealth: {
            scope: 'namespace',
            unhealthyDeployments: [{ namespace: 'app', name: 'api', ready: 0, desired: 2 }],
          },
          recentEvents: [],
          currentLogs: 'Namespace app',
        },
      };
      assert.equal(namespaceScopePlugin.isApplicable(nsCtx), true);
      const result = await namespaceScopePlugin.gather(nsCtx);
      assert.ok(result?.pointer.title.includes('Namespace'));
    }

    await runClusterScope();
    await runNamespaceScope();
  });
});

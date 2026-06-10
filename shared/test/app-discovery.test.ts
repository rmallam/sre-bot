import assert from 'node:assert/strict';
import {
  APP_ID_ANNOTATION,
  HELM_INSTANCE_LABEL,
  buildHelmInstanceCatalogGroups,
  catalogUpsertFromDeploy,
  groupDeploymentsToApps,
  matchDeploymentsForApp,
  mergeDiscoveredAppsWithCatalog,
  resolveDeploymentAppGroup,
  type DeploymentAppInput,
} from '../src/app-discovery.js';
import type { AppCatalogEntry } from '../src/app-catalog.js';
import { describe, test } from 'vitest';

describe('app-discovery', () => {
  test('legacy assertions', () => {
    const frappeDeps: DeploymentAppInput[] = [
      {
        name: 'frappe-operator-controller-manager',
        namespace: 'frappe-operator-system',
        labels: { [HELM_INSTANCE_LABEL]: 'frappe-operator' },
      },
      {
        name: 'keda-operator',
        namespace: 'frappe-operator-system',
        labels: { [HELM_INSTANCE_LABEL]: 'frappe-operator' },
      },
      {
        name: 'frappe-operator-mariadb-operator',
        namespace: 'frappe-operator-system',
        labels: { [HELM_INSTANCE_LABEL]: 'frappe-operator' },
      },
    ];

    const sreBotAgent: DeploymentAppInput = {
      name: 'commander-agent',
      namespace: 'sre-bot-system',
      annotations: { [APP_ID_ANNOTATION]: 'commander-agent' },
      labels: { [HELM_INSTANCE_LABEL]: 'sre-bot' },
    };

    assert.deepEqual(resolveDeploymentAppGroup(sreBotAgent), {
      appId: 'commander-agent',
      namespace: 'sre-bot-system',
      source: 'annotation',
    });

    assert.deepEqual(resolveDeploymentAppGroup(frappeDeps[0]!), {
      appId: 'frappe-operator',
      namespace: 'frappe-operator-system',
      source: 'helm-instance',
    });

    const grouped = groupDeploymentsToApps(frappeDeps);
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0]!.appId, 'frappe-operator');
    assert.equal(grouped[0]!.deploymentCount, 3);
    assert.equal(grouped[0]!.source, 'helm-instance');

    const helmGroups = buildHelmInstanceCatalogGroups(frappeDeps);
    assert.equal(helmGroups.length, 1);
    assert.equal(helmGroups[0]!.members.length, 3);

    const skipsAnnotated = buildHelmInstanceCatalogGroups([sreBotAgent, ...frappeDeps]);
    assert.equal(skipsAnnotated.length, 1);
    assert.equal(skipsAnnotated[0]!.appId, 'frappe-operator');

    const catalogOnly: AppCatalogEntry = {
      appId: 'legacy-app',
      namespace: 'staging',
      source: 'auto',
      members: [{ resourceKind: 'Deployment', resourceName: 'legacy-api' }],
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const { apps, namespaces } = mergeDiscoveredAppsWithCatalog(grouped, [catalogOnly]);
    assert.equal(apps.length, 2);
    assert.deepEqual(namespaces, ['frappe-operator-system', 'staging']);

    const helmMatch = matchDeploymentsForApp(frappeDeps, 'frappe-operator', 'frappe-operator-system');
    assert.equal(helmMatch.matched.length, 3);

    const catalogMatch = matchDeploymentsForApp(
      frappeDeps,
      'frappe-operator',
      'frappe-operator-system',
      [{ resourceKind: 'Deployment', resourceName: 'keda-operator' }]
    );
    assert.equal(catalogMatch.matched.length, 1);
    assert.equal(catalogMatch.matched[0]!.name, 'keda-operator');

    const upsert = catalogUpsertFromDeploy({
      releaseName: 'frappe-operator',
      namespace: 'frappe-operator-system',
      members: [{ resourceKind: 'Deployment', resourceName: 'frappe-operator-controller-manager' }],
    });
    assert.equal(upsert.source, 'auto');
    assert.equal(upsert.appId, 'frappe-operator');
  });
});

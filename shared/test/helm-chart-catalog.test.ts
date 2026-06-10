import assert from 'node:assert/strict';
import {
  listHelmCatalogToolNames,
  resolveHelmCatalog,
} from '../src/helm-chart-catalog.js';
import { parseSimpleDeploy } from '../../agents/commander/src/parser.js';
import {
  normalizeDeployCommand,
  validateDeployCommand,
} from '../src/deploy-command.js';
import { describe, test } from 'vitest';

describe('helm-chart-catalog', () => {
  test('legacy assertions', () => {
    const argocd = resolveHelmCatalog('argocd');
    assert.ok(argocd);
    assert.equal(argocd?.remote.chartRef, 'argo/argo-cd');
    assert.equal(argocd?.defaultNamespace, 'argocd');

    const argoCd = resolveHelmCatalog('argo-cd');
    assert.equal(argoCd?.id, 'argocd');

    assert.ok(resolveHelmCatalog('redis'));
    assert.ok(!resolveHelmCatalog('not-a-real-tool'));

    const names = listHelmCatalogToolNames();
    assert.ok(names.includes('argocd'));
    assert.ok(names.includes('ingress-nginx'));

    const parsed = parseSimpleDeploy('deploy argocd on this cluster');
    assert.ok(parsed);
    assert.equal(parsed?.helmRemote?.chartRef, 'argo/argo-cd');
    assert.equal(parsed?.namespace, 'argocd');
    assert.equal(parsed?.appName, 'argocd');
    assert.equal(parsed?.containerImage, undefined);

    const redisHelm = parseSimpleDeploy('deploy redis HA into redis namespace');
    assert.ok(redisHelm?.helmRemote);
    assert.equal(redisHelm?.namespace, 'redis');
    assert.equal(redisHelm?.helmRemote?.chartRef, 'bitnami/redis');

    const redisContainer = parseSimpleDeploy('deploy redis container in dev namespace');
    assert.ok(redisContainer?.containerImage);
    assert.equal(redisContainer?.helmRemote, undefined);

    const validated = validateDeployCommand(parsed!);
    assert.equal(validated.ok, true);
    if (validated.ok) {
      assert.equal(validated.appName, 'argocd');
      assert.equal(validated.deploy.helmRemote?.repoName, 'argo');
    }

    const norm = normalizeDeployCommand({
      type: 'deploy',
      githubRepo: '',
      gitRef: 'main',
      namespace: '',
      deployStrategy: 'direct',
      deployStrategyExplicit: true,
      helmRemote: argocd!.remote,
      appName: 'argocd',
    });
    assert.equal(norm.namespace, 'default');
  });
});

import assert from 'node:assert/strict';
import {
  buildDeploySourcePrompt,
  computeMissingFields,
  deploySourceRegistryKey,
  formatDeploySourceRegistryMarkdown,
  mergeDeployProvenance,
  parseProvenanceFromMetadata,
  provenanceFromRegistryMarkdown,
} from '../src/deploy-provenance.js';
import { describe, test } from 'vitest';

describe('deploy-provenance', () => {
  test('legacy assertions', () => {
    assert.equal(deploySourceRegistryKey('prod', 'Deployment', 'pay'), 'deploy-source:prod/Deployment/pay');

    const helmPartial = mergeDeployProvenance({
      method: 'helm',
      confidence: 'medium',
      source: 'cluster-labels',
      fixSurface: 'gitops-repo',
      helmRelease: { name: 'pay', namespace: 'prod' },
    });
    assert.ok(helmPartial.missingFields.includes('sourceRepo'));
    assert.ok(helmPartial.missingFields.includes('chartPath'));

    const complete = mergeDeployProvenance(helmPartial, {
      sourceRepo: 'github.com/acme/pay',
      chartPath: 'deploy/helm/pay',
      gitRef: 'main',
      source: 'user-provided',
    });
    assert.equal(complete.missingFields.length, 0);

    const fromAnn = parseProvenanceFromMetadata(
      { 'app.kubernetes.io/managed-by': 'sre-bot' },
      {
        'sre-bot.io/managed': 'true',
        'sre-bot.io/deploy-method': 'helm',
        'sre-bot.io/source-repo': 'github.com/acme/app',
        'sre-bot.io/chart-path': 'helm/app',
      }
    );
    assert.ok(fromAnn);
    assert.equal(fromAnn!.method, 'helm');
    assert.equal(fromAnn!.sourceRepo, 'github.com/acme/app');

    const fromHelm = parseProvenanceFromMetadata(
      { 'app.kubernetes.io/managed-by': 'Helm' },
      { 'meta.helm.sh/release-name': 'myapp', 'meta.helm.sh/release-namespace': 'prod' }
    );
    assert.equal(fromHelm!.method, 'helm');
    assert.equal(fromHelm!.helmRelease!.name, 'myapp');

    const prompt = buildDeploySourcePrompt('prod', 'Deployment', 'pay', helmPartial);
    assert.match(prompt, /Helm release/);
    assert.match(prompt, /hot-fix cluster/i);

    const md = formatDeploySourceRegistryMarkdown('prod', 'Deployment', 'pay', complete);
    const roundTrip = provenanceFromRegistryMarkdown(md, deploySourceRegistryKey('prod', 'Deployment', 'pay'));
    assert.equal(roundTrip!.sourceRepo, 'github.com/acme/pay');
    assert.equal(roundTrip!.chartPath, 'deploy/helm/pay');
  });
});

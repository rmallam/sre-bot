import assert from 'node:assert/strict';
import { parseDeploySourceReply, applyDeploySourceHints } from '../src/deploy-source-parse.js';
import { mergeDeployProvenance } from '../src/deploy-provenance.js';

const parsed = parseDeploySourceReply(
  'repo github.com/acme/payments chart deploy/helm/payments branch main'
);
assert.ok(parsed.provenance?.sourceRepo?.includes('acme/payments'));
assert.equal(parsed.provenance?.chartPath, 'deploy/helm/payments');
assert.equal(parsed.provenance?.gitRef, 'main');
assert.equal(parsed.provenance?.method, 'helm');

const hotfix = parseDeploySourceReply('hot-fix cluster only');
assert.equal(hotfix.allowClusterHotFix, true);

const argo = parseDeploySourceReply('argocd app prod-payments');
assert.equal(argo.provenance?.argoApp, 'prod-payments');
assert.equal(argo.provenance?.method, 'argocd');

const merged = applyDeploySourceHints(
  mergeDeployProvenance({ method: 'helm', confidence: 'medium', source: 'cluster-labels', fixSurface: 'gitops-repo', missingFields: ['sourceRepo'] }),
  parsed
);
assert.equal(merged.missingFields.length, 0);

console.log('deploy-source-parse.test.ts ok');

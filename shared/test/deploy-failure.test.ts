import assert from 'node:assert/strict';
import {
  classifyDeployFailure,
  describeDeployFailureForPlanner,
} from '../src/deploy-failure.js';

const tlsErr = new Error(
  'Command failed: kubectl apply -f x --dry-run=server\nUnable to connect to the server: tls: failed to verify certificate: x509: certificate is valid for kubernetes.default.svc'
);

const tls = classifyDeployFailure(tlsErr);
assert.equal(tls.kind, 'cluster_unreachable');
assert.equal(tls.alternateStrategyMayHelp, false);
assert.ok(tls.autoRemediations.includes('kubeconfig_insecure_tls'));

const helmCrash = classifyDeployFailure(new Error('fatal error: lfstack.push'));
assert.equal(helmCrash.kind, 'helm_tooling');
assert.equal(helmCrash.alternateStrategyMayHelp, true);

const planner = describeDeployFailureForPlanner(tlsErr);
assert.ok(planner.includes('deploy_failed[cluster_unreachable]'));

const nsErr = classifyDeployFailure(new Error('namespaces "simple" not found'));
assert.equal(nsErr.kind, 'namespace_missing');

console.log('deploy-failure tests OK');

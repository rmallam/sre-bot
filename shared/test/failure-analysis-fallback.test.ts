import assert from 'node:assert/strict';
import { classifyDeployFailure } from '../src/deploy-failure.js';
import { deterministicFailureAnalysis } from '../src/failure-analysis-fallback.js';

const tls = classifyDeployFailure(
  new Error('Unable to connect: tls: failed to verify certificate: x509')
);
const tlsAdvice = deterministicFailureAnalysis(tls, 'tls error');
assert.equal(tlsAdvice.decision, 'escalate_human');
assert.match(tlsAdvice.operatorMessage, /Not retrying Helm/i);

const git = classifyDeployFailure(new Error('Remote branch main not found'));
const gitAdvice = deterministicFailureAnalysis(git, 'branch main not found');
assert.equal(gitAdvice.decision, 'retry_with_plan');
assert.equal(gitAdvice.suggestedGitRef, 'develop');

console.log('failure-analysis-fallback tests OK');

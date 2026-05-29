import assert from 'node:assert/strict';
import { decidePostDeployRecovery } from '../src/post-deploy-recovery.js';

const image = decidePostDeployRecovery(
  'Deployment app is not ready because image pull failed (ImagePullBackOff: pull access denied)',
  'app'
);
assert.equal(image.status, 'ask_confirmation');
assert.equal(image.plan?.action, 'restart');

const crash = decidePostDeployRecovery(
  'back-off restarting failed container; CrashLoopBackOff',
  'app'
);
assert.equal(crash.status, 'auto_retry');
assert.equal(crash.plan?.action, 'restart');

const unknown = decidePostDeployRecovery('Deployment app not ready 0/1', 'app');
assert.equal(unknown.status, 'none');

console.log('post-deploy-recovery tests OK');

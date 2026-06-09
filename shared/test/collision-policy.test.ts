import assert from 'node:assert/strict';
import { assessDeployCollision } from '../src/deploy/collision-policy.js';

const fresh = assessDeployCollision({
  namespace: 'demo',
  appName: 'myapp',
  existingDeployments: [],
});
assert.equal(fresh.mode, 'fresh');
assert.equal(fresh.requireReinstallConfirm, false);

const collision = assessDeployCollision({
  namespace: 'frappe-operator-system',
  appName: 'frappe-operator',
  existingDeployments: ['frappe-operator-controller', 'mariadb-operator'],
});
assert.equal(collision.mode, 'upgrade');
assert.equal(collision.matchingDeployments.length, 1);
assert.ok(collision.warning?.includes('frappe-operator-controller'));

const unrelatedCollision = assessDeployCollision({
  namespace: 'demo',
  appName: 'other-app',
  existingDeployments: ['frappe-operator-controller', 'mariadb-operator'],
});
assert.equal(unrelatedCollision.mode, 'fresh');
assert.equal(unrelatedCollision.requireReinstallConfirm, true);

const upgrade = assessDeployCollision({
  namespace: 'demo',
  appName: 'myapp',
  existingDeployments: ['myapp'],
  userHint: 'upgrade myapp to latest',
});
assert.equal(upgrade.mode, 'upgrade');
assert.equal(upgrade.requireReinstallConfirm, false);

const reinstall = assessDeployCollision({
  namespace: 'demo',
  appName: 'myapp',
  existingDeployments: ['myapp'],
  userHint: 'reinstall fresh',
});
assert.equal(reinstall.mode, 'reinstall');
assert.equal(reinstall.requireReinstallConfirm, true);

console.log('collision-policy.test.ts: ok');

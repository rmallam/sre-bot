import assert from 'node:assert/strict';

// Heuristic-only test (no cluster required)
const podName = 'simple-app-on-kubernetes-f49dc8854-2wpz5';
const guess = podName.replace(/-[a-z0-9]{5,10}-[a-z0-9]{5,10}$/i, '');
assert.equal(guess, 'simple-app-on-kubernetes');

console.log('cluster-patch heuristic tests OK');

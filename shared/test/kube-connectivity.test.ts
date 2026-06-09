import assert from 'node:assert/strict';
import { isInClusterKube } from '../src/kube-connectivity.js';

assert.equal(typeof isInClusterKube(), 'boolean');

console.log('kube-connectivity.test.ts OK');

import assert from 'node:assert/strict';
import { isInClusterKube } from '../src/kube-connectivity.js';
import { describe, test } from 'vitest';

describe('kube-connectivity', () => {
  test('legacy assertions', () => {
    assert.equal(typeof isInClusterKube(), 'boolean');
  });
});

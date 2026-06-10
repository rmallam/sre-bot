import assert from 'node:assert/strict';
import { buildKubeConfig } from '../src/kube-config.js';
import { describe, test } from 'vitest';

describe('kube-config', () => {
  test('legacy assertions', () => {
    /** Requires @kubernetes/client-node (agent NODE_PATH when run from shared/test). */
    const kc = buildKubeConfig();
    assert.ok(kc);
    assert.equal(typeof kc.makeApiClient, 'function');
  });
});

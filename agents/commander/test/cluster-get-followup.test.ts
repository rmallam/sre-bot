import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { isClusterListExpandFollowUp } from '../src/cluster-get-followup.js';

describe('cluster-get-followup', () => {
  test('detects expand phrases', () => {
    assert.equal(isClusterListExpandFollowUp('more detail'), true);
    assert.equal(isClusterListExpandFollowUp('show all'), true);
    assert.equal(isClusterListExpandFollowUp('full list please'), true);
    assert.equal(isClusterListExpandFollowUp('expand the list'), true);
  });

  test('rejects unrelated messages', () => {
    assert.equal(isClusterListExpandFollowUp('list pods in default'), false);
    assert.equal(isClusterListExpandFollowUp('investigate redis'), false);
    assert.equal(isClusterListExpandFollowUp(''), false);
  });
});

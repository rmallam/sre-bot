import assert from 'node:assert/strict';
import { resolveGitPatchTarget, parsePatchTarget } from '../src/patch-target.js';
import { describe, test } from 'vitest';

describe('patch-target', () => {
  test('legacy assertions', () => {
    assert.equal(parsePatchTarget('direct'), 'cluster');
    assert.equal(parsePatchTarget('mirror'), 'gitops');
    assert.equal(resolveGitPatchTarget({ envMode: 'cluster' }), 'cluster');
    assert.equal(resolveGitPatchTarget({ envMode: 'gitops' }), 'gitops');
    assert.equal(
      resolveGitPatchTarget({ envMode: 'auto', diagnoseMode: true, clusterPatchFirstEnv: 'true' }),
      'cluster'
    );
    assert.equal(
      resolveGitPatchTarget({ planTarget: 'gitops', envMode: 'cluster' }),
      'gitops'
    );
    assert.equal(
      resolveGitPatchTarget({ envMode: 'auto', clusterPatchFirstEnv: 'false' }),
      'gitops'
    );
  });
});

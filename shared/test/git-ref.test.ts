import assert from 'node:assert/strict';
import { isGitCloneTarget } from '../src/git-ref.js';
import { describe, test } from 'vitest';

describe('git-ref', () => {
  test('legacy assertions', () => {
    assert.equal(isGitCloneTarget(''), false);
    assert.equal(isGitCloneTarget(undefined), false);
    assert.equal(isGitCloneTarget('catalog/local'), false);
    assert.equal(isGitCloneTarget('github.com/org/repo'), true);
  });
});

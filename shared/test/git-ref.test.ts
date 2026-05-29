import assert from 'node:assert/strict';
import { isGitCloneTarget } from '../src/git-ref.js';

assert.equal(isGitCloneTarget(''), false);
assert.equal(isGitCloneTarget(undefined), false);
assert.equal(isGitCloneTarget('catalog/local'), false);
assert.equal(isGitCloneTarget('github.com/org/repo'), true);

console.log('git-ref.test.ts: ok');

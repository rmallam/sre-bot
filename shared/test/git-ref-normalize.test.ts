import assert from 'node:assert/strict';
import {
  normalizeGithubRepoSlug,
  normalizeRequestedGitRef,
  toHttpsCloneUrl,
} from '../src/git-ref.js';
import { describe, test } from 'vitest';

describe('git-ref-normalize', () => {
  test('legacy assertions', () => {
    assert.equal(
      normalizeGithubRepoSlug('github.com/https://github.com/vyogotech/frappe-operator'),
      'github.com/vyogotech/frappe-operator'
    );
    assert.equal(
      normalizeGithubRepoSlug('https://github.com/vyogotech/frappe-operator'),
      'github.com/vyogotech/frappe-operator'
    );
    assert.equal(toHttpsCloneUrl('github.com/org/app'), 'https://github.com/org/app');

    assert.equal(normalizeRequestedGitRef('latest'), undefined);
    assert.equal(normalizeRequestedGitRef('main'), 'main');
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  autoGitRollbackEnabled,
  canAttemptGitRollback,
  namespaceAllowsAutoRollback,
} from '../src/deploy-git-rollback.js';

describe('deploy-git-rollback', () => {
  test('canAttemptGitRollback requires deploy commit', () => {
    const prev = process.env['AUTO_GIT_ROLLBACK_ENABLED'];
    process.env['AUTO_GIT_ROLLBACK_ENABLED'] = 'true';
    const gate = canAttemptGitRollback(undefined, 'staging');
    assert.equal(gate.allowed, false);
    if (prev === undefined) delete process.env['AUTO_GIT_ROLLBACK_ENABLED'];
    else process.env['AUTO_GIT_ROLLBACK_ENABLED'] = prev;
  });

  test('namespaceAllowsAutoRollback blocks production namespaces', () => {
    assert.equal(namespaceAllowsAutoRollback('production'), false);
    assert.equal(namespaceAllowsAutoRollback('staging'), true);
  });

  test('autoGitRollbackEnabled respects env', () => {
    const prev = process.env['AUTO_GIT_ROLLBACK_ENABLED'];
    process.env['AUTO_GIT_ROLLBACK_ENABLED'] = 'true';
    assert.equal(autoGitRollbackEnabled(), true);
    if (prev === undefined) delete process.env['AUTO_GIT_ROLLBACK_ENABLED'];
    else process.env['AUTO_GIT_ROLLBACK_ENABLED'] = prev;
  });
});

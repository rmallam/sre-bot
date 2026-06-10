import assert from 'node:assert/strict';
import {
  validateStartRunRequest,
  formatDeployDispatchError,
  validateDeployCommand,
} from '../src/deploy-command.js';
import { describe, test } from 'vitest';

describe('deploy-command', () => {
  test('legacy assertions', () => {
    const missing = validateStartRunRequest({
      incidentId: 'abc',
      namespace: '',
      resourceName: '',
      mode: 'pre-deploy',
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.ok(missing.userMessage.includes('namespace') || missing.userMessage.includes('Namespace'));
      assert.ok(!/incidentId, namespace, resourceName required/i.test(missing.userMessage));
    }

    const formatted = formatDeployDispatchError(
      new Error('incidentId, namespace, resourceName required'),
      { githubRepo: 'github.com/vyogotech/frappe-operator' }
    );
    assert.ok(!/incidentId, namespace, resourceName required/i.test(formatted));
    assert.ok(formatted.includes('namespace') || formatted.includes('GitHub'));

    const incomplete = validateDeployCommand({
      type: 'deploy',
      githubRepo: '',
      gitRef: 'main',
      namespace: '',
      deployStrategy: 'gitops',
      deployStrategyExplicit: false,
    });
    assert.equal(incomplete.ok, false);
    if (!incomplete.ok) {
      assert.ok(incomplete.userMessage.includes('GitHub'));
    }
  });
});

import assert from 'node:assert/strict';
import {
  formatToolDisplayLabel,
  formatToolSummaryDetail,
} from '../src/tool-user-labels.js';
import { describe, test } from 'vitest';

describe('tool-user-labels', () => {
  test('legacy assertions', () => {
    assert.equal(
      formatToolDisplayLabel('investigator.repo_inspect'),
      'Reviewed repository for deploy instructions'
    );
    assert.equal(formatToolDisplayLabel('gitops.apply_plan', 'repo_apply'), 'Deployed to the cluster');
    assert.equal(
      formatToolSummaryDetail('gitops.apply_plan', 'repo_apply', 'repo_apply'),
      'Deployed manifests and charts to the cluster'
    );
    assert.equal(
      formatToolSummaryDetail('investigator.verify_health', 'healthy'),
      'All checked components are ready'
    );
  });
});

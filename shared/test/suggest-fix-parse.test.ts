import assert from 'node:assert/strict';
import { tryParseOperatorSuggestion } from '../src/suggest-fix-parse.js';
import type { RemediationPlan } from '../src/types.js';
import { describe, test } from 'vitest';

describe('suggest-fix-parse', () => {
  test('legacy assertions', () => {
    const base: RemediationPlan = {
      action: 'git_patch',
      rootCause: 'test',
      reasoning: 'bot',
      severity: 'HIGH',
      proposedPatch: [],
      targetManifestPath: 'deployments/app.yaml',
      commitMessage: 'fix',
      rollbackSafe: true,
    };

    const ctx = {
      namespace: 'simple',
      resourceKind: 'Pod' as const,
      resourceName: 'app-abc12345-xyz99',
      basePlan: base,
    };

    const restart = tryParseOperatorSuggestion('please restart the deployment', ctx);
    assert.equal(restart?.action, 'restart');

    const secret = tryParseOperatorSuggestion('add imagePullSecrets ghcr-creds', ctx);
    assert.equal(secret?.action, 'git_patch');
    assert.ok(
      secret?.proposedPatch.some((p) => p.path.includes('imagePullSecrets'))
    );

    const image = tryParseOperatorSuggestion('set image to nginx:1.25', ctx);
    assert.equal(image?.proposedPatch[0]?.value, 'nginx:1.25');
  });
});

import assert from 'node:assert/strict';
import {
  assessGitPatchPreflight,
  clusterHotFixFallbackPlan,
  isGitMirrorFailure,
} from '../src/git-patch-preflight.js';
import type { RemediationPlan } from '../src/types.js';
import { describe, test } from 'vitest';

describe('git-patch-preflight', () => {
  test('legacy assertions', () => {
    const imagePlan: RemediationPlan = {
      action: 'git_patch',
      rootCause: 'ImagePullBackOff',
      reasoning: 'set image',
      severity: 'HIGH',
      proposedPatch: [
        { op: 'replace', path: '/spec/template/spec/containers/0/image', value: 'ghcr.io/org/app:latest' },
      ],
      targetManifestPath: 'deployments/app.yaml',
      commitMessage: 'fix: image',
      rollbackSafe: true,
    };

    assert.equal(
      assessGitPatchPreflight({
        plan: imagePlan,
        mode: 'diagnose',
        resourceKind: 'Deployment',
        resourceName: 'app',
        facts: { phase: 'Running' },
      }).allowed,
      true
    );

    const noFacts = assessGitPatchPreflight({
      plan: imagePlan,
      mode: 'diagnose',
      resourceKind: 'Pod',
      resourceName: 'app-abc-xyz',
      facts: {},
    });
    assert.equal(noFacts.allowed, false);
    assert.ok(noFacts.issues.some((i) => i.code === 'cluster_target_unverified'));

    const normalized = assessGitPatchPreflight({
      plan: { ...imagePlan, patchTarget: 'auto' },
      mode: 'diagnose',
      resourceKind: 'Deployment',
      resourceName: 'app',
      facts: { phase: 'Pending', currentLogs: 'pull error' },
      gitopsRepoUrl: '',
    });
    assert.equal(normalized.allowed, true);
    assert.equal(normalized.normalizedPlan?.patchTarget, 'cluster');

    assert.ok(isGitMirrorFailure('Git mirror applyPatchAndPush failed'));
    const fallback = clusterHotFixFallbackPlan(imagePlan, 'mirror missing');
    assert.equal(fallback.patchTarget, 'cluster');
    assert.match(fallback.reasoning, /cluster hot-fix/i);
  });
});

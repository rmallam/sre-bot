import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

describe('skills-loader', () => {
  test('legacy assertions', async () => {
    const {
      buildSkillsQueryText,
      inferTargetComponent,
      loadRankedSkills,
    } = await import('../src/skills-loader.js');

    assert.equal(
      inferTargetComponent({ mode: 'ci-failure' }),
      'gitops',
      'CI failures query gitops runbooks'
    );
    assert.equal(
      inferTargetComponent({ mode: 'diagnose', namespace: 'default' }),
      'compute',
      'cluster diagnose defaults to compute'
    );
    assert.equal(
      inferTargetComponent({ targetComponent: 'network' }),
      'network',
      'explicit target wins'
    );

    const k8sQuery = buildSkillsQueryText({
      mode: 'diagnose',
      namespace: 'default',
      resourceName: 'frappe-operator',
      errorSignature: 'ImagePullBackOff',
      rootCause: 'Failed to pull image tag v9',
    });
    assert.match(k8sQuery, /ImagePullBackOff/);
    assert.match(k8sQuery, /default\/frappe-operator/);

    const ciQuery = buildSkillsQueryText({
      mode: 'ci-failure',
      githubRepo: 'org/my-app',
      errorSignature: 'dependency_env',
    });
    assert.match(ciQuery, /org\/my-app/);
    assert.match(ciQuery, /ci-failure/);

    // Without platform URL, RAG fetch is skipped gracefully.
    delete process.env['SRE_PLATFORM_URL'];
    delete process.env['PLATFORM_URL'];
    process.env['SRE_RAG_GROUNDING'] = 'true';
    const empty = await loadRankedSkills({ mode: 'diagnose' });
    assert.equal(empty, '');
  });
});

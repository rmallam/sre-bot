import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  inspectHelmDependencies,
  isHelmDependencyError,
  parseChartDependencies,
} from '../src/helm-dependencies.js';
import { classifyDeployFailure } from '../src/deploy-failure.js';
import { describe, test } from 'vitest';

describe('helm-dependencies', () => {
  test('legacy assertions', async () => {
    const deps = parseChartDependencies(`
    dependencies:
      - name: mariadb-operator
        version: "0.34.0"
        repository: https://example.com
    `);
    assert.deepEqual(deps, ['mariadb-operator']);

    assert.equal(
      isHelmDependencyError(
        new Error('found in Chart.yaml, but missing in charts/ directory: mariadb-operator')
      ),
      true
    );

    const depFail = classifyDeployFailure(
      new Error('found in Chart.yaml, but missing in charts/ directory: mariadb-operator')
    );
    assert.equal(depFail.kind, 'helm_tooling');
    assert.equal(depFail.alternateStrategyMayHelp, true);

    const root = mkdtempSync(join(tmpdir(), 'sre-helm-dep-'));
    writeFileSync(
      join(root, 'Chart.yaml'),
      'apiVersion: v2\nname: test\ndependencies:\n  - name: sub\n    version: 1.0.0\n    repository: https://example.com\n'
    );
    const before = await inspectHelmDependencies(root);
    assert.equal(before.hasDependencies, true);
    assert.equal(before.vendored, false);

    mkdirSync(join(root, 'charts'), { recursive: true });
    writeFileSync(join(root, 'charts', 'sub-1.0.0.tgz'), 'fake');
    const after = await inspectHelmDependencies(root);
    assert.equal(after.vendored, true);
  });
});

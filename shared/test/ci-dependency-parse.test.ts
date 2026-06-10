import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMissingDependency } from '../src/ci-dependency-parse.js';
import { diagnoseCiRun } from '../src/ci-diagnose.js';
import { describe, test } from 'vitest';

describe('ci-dependency-parse', () => {
  test('legacy assertions', () => {
    describe('parseMissingDependency', () => {
      it('detects Python module', () => {
        const h = parseMissingDependency("ModuleNotFoundError: No module named 'requests'");
        assert.equal(h?.ecosystem, 'python');
        assert.equal(h?.packageName, 'requests');
      });

      it('diagnose maps to dependency_env', () => {
        const d = diagnoseCiRun({
          logExcerpt: "ModuleNotFoundError: No module named 'httpx'",
          conclusion: 'failure',
          failedJobs: [],
        });
        assert.equal(d.fixCategory, 'dependency_env');
        assert.equal(d.suggestedAction, 'propose_code_pr');
      });
    });
  });
});

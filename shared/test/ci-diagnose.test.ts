import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseCiRun, extractErrorHighlight, formatCiReport } from '../src/ci-diagnose.js';
import type { CiRunFacts } from '../src/ci-types.js';
import { patchWorkflowYaml } from '../src/ci-workflow-patch.js';
import { describe, test } from 'vitest';

describe('ci-diagnose', () => {
  test('legacy assertions', () => {
    describe('diagnoseCiRun', () => {
      it('classifies test failures as application code / report_only', () => {
        const facts: CiRunFacts = {
          githubRepo: 'org/app',
          workflowRunId: 1,
          workflowName: 'CI',
          branch: 'main',
          headSha: 'abc',
          status: 'completed',
          conclusion: 'failure',
          htmlUrl: 'https://github.com/org/app/actions/runs/1',
          event: 'push',
          failedJobs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'failure', htmlUrl: '' }],
          logExcerpt: 'npm ERR! Test suite failed',
        };
        const d = diagnoseCiRun(facts);
        assert.equal(d.kind, 'test_failure');
        assert.equal(d.fixCategory, 'application_code');
        assert.equal(d.suggestedAction, 'report_only');
      });

      it('classifies git push 500 as transient infra / rerun', () => {
        const log =
          'remote: Internal Server Error\nfatal: unable to access https://github.com/rmallam/blogs/: The requested URL returned error: 500';
        const d = diagnoseCiRun({
          logExcerpt: log,
          conclusion: 'failure',
          failedJobs: [{ id: 1, name: 'generate', status: 'completed', conclusion: 'failure', htmlUrl: '' }],
        });
        assert.equal(d.kind, 'git_push_failure');
        assert.equal(d.fixCategory, 'transient_infra');
        assert.equal(d.suggestedAction, 'rerun');
      });

      it('classifies deprecated actions as workflow_config / open_pr', () => {
        const d = diagnoseCiRun({
          logExcerpt: 'Node.js 20 actions are deprecated: actions/checkout@v3',
          conclusion: 'failure',
          failedJobs: [],
        });
        assert.equal(d.fixCategory, 'workflow_config');
        assert.equal(d.suggestedAction, 'open_pr');
      });

      it('formatCiReport mentions no PR for application code', () => {
        const facts: CiRunFacts = {
          githubRepo: 'org/app',
          workflowRunId: 2,
          workflowName: 'build',
          branch: 'main',
          headSha: 'def',
          status: 'completed',
          conclusion: 'failure',
          htmlUrl: 'https://github.com/org/app/actions/runs/2',
          event: 'push',
          failedJobs: [],
          logExcerpt: 'npm ERR! test failed',
          diagnosis: {
            kind: 'test_failure',
            fixCategory: 'application_code',
            summary: 'CI failed — application code',
            suggestedAction: 'report_only',
            confidence: 0.85,
            errorHighlight: ['npm ERR! test failed'],
          },
        };
        const report = formatCiReport(facts);
        assert.match(report, /application code/i);
        assert.match(report, /No automated PR/i);
      });
    });

    describe('extractErrorHighlight', () => {
      it('pulls error lines from logs', () => {
        const lines = extractErrorHighlight('ok\n##[error]Process completed with exit code 1\n');
        assert.ok(lines.some((l) => l.includes('error')));
      });
    });

    describe('patchWorkflowYaml', () => {
      it('bumps checkout v3 to v4', () => {
        const yaml = 'steps:\n  - uses: actions/checkout@v3\n';
        const result = patchWorkflowYaml(yaml, '');
        assert.equal(result.patched, true);
        assert.match(result.content, /checkout@v4/);
      });
    });
  });
});

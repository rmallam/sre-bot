import assert from 'node:assert/strict';
import { scoreWorkloadHint } from '../../agents/investigator/src/workload-resolve.js';
import { describe, test } from 'vitest';

describe('workload-score', () => {
  test('legacy assertions', () => {
    assert.ok(scoreWorkloadHint('appache', 'apache') >= 80);
    assert.equal(scoreWorkloadHint('apache', 'apache'), 100);
    assert.equal(scoreWorkloadHint('ngninx', 'nginx'), 82);
    assert.equal(scoreWorkloadHint('httpd', 'apache'), 0);
  });
});

import assert from 'node:assert/strict';
import {
  formatSuggestedActionLabel,
  isStaleRunningRun,
  STALE_RUNNING_MS,
} from '../src/stale-run.js';
import { describe, test } from 'vitest';

describe('stale-run', () => {
  test('legacy assertions', () => {
    const now = Date.now();
    const hoursAgo = (h: number) => new Date(now - h * 60 * 60 * 1000).toISOString();

    assert.equal(
      isStaleRunningRun({
        status: 'running',
        transcript: [],
        startedAt: hoursAgo(3),
        updatedAt: hoursAgo(3),
      }),
      true
    );

    assert.equal(
      isStaleRunningRun({
        status: 'running',
        transcript: [{ tool: 'investigator' }],
        startedAt: hoursAgo(1),
        updatedAt: hoursAgo(1),
      }),
      false
    );

    assert.equal(
      isStaleRunningRun({
        status: 'running',
        transcript: [{ tool: 'investigator' }],
        startedAt: hoursAgo(5),
        updatedAt: hoursAgo(5),
      }),
      true
    );

    assert.equal(
      isStaleRunningRun({
        status: 'succeeded',
        transcript: [],
        startedAt: hoursAgo(10),
        updatedAt: hoursAgo(10),
      }),
      false
    );

    assert.equal(
      formatSuggestedActionLabel('unknown', { status: 'running', toolCount: 0 }),
      'No plan yet'
    );

    assert.equal(
      formatSuggestedActionLabel('restart', { status: 'running', toolCount: 0 }),
      'restart'
    );

    assert.equal(
      formatSuggestedActionLabel('unknown', { status: 'running', toolCount: 0, isStale: true }),
      'Orphaned — no plan recorded'
    );

    assert.ok(STALE_RUNNING_MS > 0);
  });
});

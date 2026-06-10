import { describe, expect, test } from 'vitest';
import {
  buildRemediationOutcome,
  filterDisplayActionsTaken,
  inferOutcomeWorkedLabel,
  isNoopInvestigationOutcome,
} from '../src/remediation-outcome.js';
import type { StoredRun } from '../src/run-persistence.js';
import type { RemediationPlan } from '../src/types.js';

function stubRun(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    runId: 'run-12345678',
    incidentId: 'inc-12345678',
    status: 'succeeded',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    transcript: [],
    metadata: {},
    ...overrides,
  };
}

describe('remediation-outcome noop UX', () => {
  test('noop succeeded is not marked as worked', () => {
    const plan: RemediationPlan = {
      action: 'noop',
      rootCause: 'Pod healthy — no intervention needed',
      reasoning: 'All containers running',
      severity: 'LOW',
      proposedPatch: [],
      targetManifestPath: '',
      commitMessage: '',
      rollbackSafe: true,
    };

    const outcome = buildRemediationOutcome({
      run: stubRun(),
      status: 'succeeded',
      plan,
      actionHistory: [
        {
          action: 'noop',
          success: false,
          summary: 'No tool calls in capability plan',
          at: new Date().toISOString(),
        },
      ],
      lastError: 'No tool calls in capability plan',
    });

    expect(isNoopInvestigationOutcome('succeeded', 'noop')).toBe(true);
    expect(outcome.worked).toBeNull();
    expect(outcome.actionsTaken).toEqual([]);
    expect(outcome.followUp).toBe('Investigation completed — no automated fix was recommended.');
    expect(inferOutcomeWorkedLabel(outcome.worked, 'succeeded', 'noop')).toBe('No action taken');
  });

  test('filterDisplayActionsTaken hides noop pipeline artifacts', () => {
    const filtered = filterDisplayActionsTaken(undefined, [
      { action: 'noop', success: false, summary: 'No tool calls in capability plan' },
      { action: 'restart', success: true, summary: 'restarted deployment' },
    ]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.action).toBe('restart');
  });

  test('successful restart still counts as worked', () => {
    const outcome = buildRemediationOutcome({
      run: stubRun(),
      status: 'succeeded',
      plan: {
        action: 'restart',
        rootCause: 'CrashLoopBackOff',
        reasoning: 'Transient failure',
        severity: 'MEDIUM',
        proposedPatch: [],
        targetManifestPath: '',
        commitMessage: 'fix: restart',
        rollbackSafe: true,
      },
      actionHistory: [
        { action: 'restart', success: true, summary: 'restarted', at: new Date().toISOString() },
      ],
    });
    expect(outcome.worked).toBe(true);
  });
});

import assert from 'node:assert/strict';
import {
  normalizeStoredRun,
  normalizeToolCalls,
  toolCallNames,
  type StoredRun,
} from '../src/run-persistence.js';
import { describe, test } from 'vitest';

describe('run-normalize', () => {
  test('legacy assertions', () => {
    const calls = [
      { name: 'executor.restart_workload', input: { incidentId: 'x' } },
      { name: 'investigator.verify_health', input: { incidentId: 'x' } },
    ];

    assert.deepEqual(normalizeToolCalls(calls).length, 2);
    assert.deepEqual(toolCallNames(calls), ['executor.restart_workload', 'investigator.verify_health']);

    const objectShaped = {
      '0': calls[0],
      '1': calls[1],
    };
    assert.deepEqual(normalizeToolCalls(objectShaped).length, 2);

    const single = { name: 'commander.notify', input: { message: 'hi' } };
    assert.deepEqual(normalizeToolCalls(single).length, 1);

    assert.deepEqual(normalizeToolCalls(null), []);
    assert.deepEqual(normalizeToolCalls('bad'), []);

    const brokenRun: StoredRun = {
      runId: 'run-1',
      incidentId: 'inc-1',
      status: 'escalated',
      transcript: [],
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      capabilityToolCalls: objectShaped as unknown as StoredRun['capabilityToolCalls'],
      compiled: {
        confidence: 0.8,
        riskLevel: 'low',
        validation: { ok: true, errors: [] },
        calls: objectShaped as unknown as typeof calls,
      },
    };

    const normalized = normalizeStoredRun(brokenRun);
    assert.equal(normalized.capabilityToolCalls?.length, 2);
    assert.equal(normalized.compiled?.calls.length, 2);
    assert.deepEqual(toolCallNames(normalized.capabilityToolCalls), [
      'executor.restart_workload',
      'investigator.verify_health',
    ]);
  });
});

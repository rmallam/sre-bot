import assert from 'node:assert/strict';
import {
  filterTranscriptAfterClear,
  recoverWaitingForRun,
} from '../src/chat-waiting-state.js';
import { describe, test } from 'vitest';

describe('chat-waiting-state', () => {
  test('legacy assertions', () => {
    assert.equal(
      recoverWaitingForRun({
        waitingForRun: true,
        lastRunId: undefined,
        transcript: [{ role: 'assistant', liveUpdate: true, incidentId: 'pending' }],
      }),
      true
    );

    assert.equal(
      recoverWaitingForRun({
        waitingForRun: true,
        lastRunId: undefined,
        transcript: [
          { role: 'user', content: 'investigate' },
          { role: 'assistant', content: 'Cluster is healthy' },
        ],
      }),
      false
    );

    assert.equal(
      recoverWaitingForRun({
        waitingForRun: true,
        lastRunId: 'run-123',
        transcript: [],
      }),
      true
    );

    const transcript = [
      { role: 'assistant', liveUpdate: true, incidentId: 'pending' },
      { role: 'user', incidentId: 'x' },
      { role: 'assistant', incidentId: 'inc-1', liveUpdate: true },
      { role: 'assistant', incidentId: 'inc-1', content: 'final' },
    ];

    const clearedPending = filterTranscriptAfterClear(transcript, 'pending');
    assert.equal(clearedPending.length, 2);
    assert.ok(clearedPending.every((t) => !t.liveUpdate || t.incidentId !== 'pending'));

    const clearedIncident = filterTranscriptAfterClear(transcript, 'inc-1');
    assert.equal(clearedIncident.length, 3);
    assert.ok(clearedIncident.every((t) => t.incidentId !== 'inc-1' || !t.liveUpdate));
  });
});

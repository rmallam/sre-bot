import assert from 'node:assert/strict';
import { parseEventInvestigation } from '../src/parser.js';
import { describe, test } from 'vitest';

describe('event-investigate-parser', () => {
  test('legacy assertions', () => {
    const eventText =
      'investigate this • Unhealthy: Readiness probe failed: Get "http://10.244.0.114:8080/health": context deadline exceeded';

    const cmd = parseEventInvestigation(eventText);
    assert.ok(cmd);
    assert.equal(cmd!.scope, 'event');
    assert.ok(cmd!.eventReason?.toLowerCase().includes('unhealthy'));
    assert.ok(cmd!.eventMessage?.includes('Readiness probe failed'));

    assert.equal(parseEventInvestigation('investigate cluster health'), null);
  });
});

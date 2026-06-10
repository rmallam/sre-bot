import assert from 'node:assert/strict';
import { parseAppInvestigation, parseEventInvestigation, parseCommand } from '../src/parser.js';
import { describe, test } from 'vitest';

describe('app-investigate-parser', () => {
  test('legacy assertions', () => {
    const appPhrases = [
      'investigate app frappe-operator',
      "why isn't frappe-operator working",
      'app review for checkout',
    ];

    for (const phrase of appPhrases) {
      const cmd =
        parseAppInvestigation(phrase) ??
        (() => {
          const parsed = parseCommand(phrase);
          return parsed.type === 'investigate' ? parsed : null;
        })();
      assert.ok(cmd, `expected investigate parse for: ${phrase}`);
      if (phrase.includes('app ') || phrase.startsWith('app review')) {
        assert.equal(cmd!.scope, 'app');
      }
    }

    const eventPhrase = parseEventInvestigation('investigate this Unhealthy readiness probe failed');
    assert.ok(eventPhrase);
    assert.equal(eventPhrase!.scope, 'event');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandIntentJson } from '../src/command-intent.js';

describe('parseCommandIntentJson', () => {
  it('parses unified intent with userReply and confidence', () => {
    const intent = parseCommandIntentJson(
      JSON.stringify({
        intent: 'deploy',
        confidence: 0.92,
        userReply: 'Deploying httpd to staging.',
        workloadHint: 'httpd',
        namespace: 'staging',
      })
    );
    assert.ok(intent);
    assert.equal(intent!.intent, 'deploy');
    assert.equal(intent!.confidence, 0.92);
    assert.equal(intent!.userReply, 'Deploying httpd to staging.');
    assert.equal(intent!.namespace, 'staging');
  });

  it('rejects invalid intent', () => {
    assert.equal(parseCommandIntentJson('{"intent":"fly"}'), null);
  });
});

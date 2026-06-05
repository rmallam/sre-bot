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

  it('parses containerImage and operatorSuggestion on investigate', () => {
    const intent = parseCommandIntentJson(
      JSON.stringify({
        intent: 'investigate',
        confidence: 0.88,
        userReply: 'Fixing the operator image.',
        workloadHint: 'frappe-operator',
        namespace: 'frappe-operator-system',
        containerImage: 'ghcr.io/vyogotech/frappe-operator:latest',
        operatorSuggestion: 'set image to ghcr.io/vyogotech/frappe-operator:latest',
      })
    );
    assert.ok(intent);
    assert.equal(intent!.containerImage, 'ghcr.io/vyogotech/frappe-operator:latest');
    assert.equal(intent!.operatorSuggestion, 'set image to ghcr.io/vyogotech/frappe-operator:latest');
  });

  it('rejects invalid intent', () => {
    assert.equal(parseCommandIntentJson('{"intent":"fly"}'), null);
  });
});

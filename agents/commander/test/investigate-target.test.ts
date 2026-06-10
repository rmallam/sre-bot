import assert from 'node:assert/strict';
import { parseCommand } from '../src/parser.js';
import {
  extractOperatorNamespaceHint,
  extractContainerImageHint,
  workloadHintFromNamespace,
  resolveOperatorSuggestion,
  normalizeContainerImageRef,
} from '../src/investigate-target.js';
import { describe, test } from 'vitest';

describe('investigate-target', () => {
  test('legacy assertions', () => {
    const msg =
      'fix frappe-operator-system using the vyogotech ghcr latest image';

    assert.equal(extractOperatorNamespaceHint(msg), 'frappe-operator-system');
    assert.equal(workloadHintFromNamespace('frappe-operator-system'), 'frappe-operator');
    assert.equal(
      extractContainerImageHint(msg, 'frappe-operator'),
      'ghcr.io/vyogotech/frappe-operator:latest'
    );
    assert.equal(
      resolveOperatorSuggestion({ text: msg, workloadHint: 'frappe-operator' }),
      'set image to ghcr.io/vyogotech/frappe-operator:latest'
    );
    assert.equal(
      resolveOperatorSuggestion({
        text: 'fix the deployment',
        workloadHint: 'frappe-operator',
        llmContainerImage: 'ghcr.io/vyogotech/frappe-operator:v2.0.1',
      }),
      'set image to ghcr.io/vyogotech/frappe-operator:v2.0.1'
    );
    assert.equal(
      normalizeContainerImageRef('set image to ghcr.io/acme/app:latest'),
      'ghcr.io/acme/app:latest'
    );

    const parsed = parseCommand(msg);
    assert.equal(parsed.type, 'investigate');
    if (parsed.type === 'investigate') {
      assert.equal(parsed.namespace, 'frappe-operator-system');
      assert.equal(parsed.workloadHint, 'frappe-operator');
      assert.ok(parsed.operatorSuggestion?.includes('ghcr.io/vyogotech/frappe-operator:latest'));
    }
  });
});

import { sanitizeText } from '../src/sanitize.js';
import { validatePatch } from '../src/rules/patch-validator.js';
import { validateHelmChart } from '../src/rules/helm-validator.js';
import { describe, test } from 'vitest';

describe('sanitize', () => {
  test('legacy assertions', () => {
    function assert(cond: boolean, msg: string): void {
      if (!cond) throw new Error(msg);
    }

    // Secret redaction
    const r1 = sanitizeText('password=supersecret123');
    assert(r1.text.includes('[REDACTED]'), 'password redacted');

    // JWT redaction
    const r2 = sanitizeText('token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U');
    assert(r2.text.includes('[REDACTED]'), 'jwt redacted');

    // Patch deny cluster role
    const p = validatePatch([{ op: 'add', path: '', value: { kind: 'ClusterRole', apiVersion: 'v1' } }]);
    assert(!p.allowed, 'cluster role patch denied');

    // Helm privileged deny
    const h = validateHelmChart({ 'templates/deploy.yaml': 'privileged: true' });
    assert(!h.allowed, 'privileged helm denied');
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  evaluateNumericExpectation,
  parsePlaybookVerifySteps,
  substituteVerifyTemplate,
} from '../src/playbook-verify.js';

describe('playbook-verify', () => {
  test('parsePlaybookVerifySteps reads http and promql steps', () => {
    const md = `
## Verification
- type: http url: http://{workload}.{namespace}.svc/health expect_status: 200
- type: promql query: rate(errors[5m]) expect: < 0.05
`;
    const steps = parsePlaybookVerifySteps(md);
    assert.equal(steps.length, 2);
    assert.equal(steps[0]?.type, 'http');
    assert.equal(steps[1]?.type, 'promql');
  });

  test('substituteVerifyTemplate replaces placeholders', () => {
    const out = substituteVerifyTemplate('http://{workload}.{namespace}.svc/health', {
      namespace: 'checkout',
      resourceName: 'payments-api',
    });
    assert.equal(out, 'http://payments-api.checkout.svc/health');
  });

  test('evaluateNumericExpectation supports comparison operators', () => {
    assert.equal(evaluateNumericExpectation(0.01, '< 0.05'), true);
    assert.equal(evaluateNumericExpectation(0.2, '< 0.05'), false);
  });
});

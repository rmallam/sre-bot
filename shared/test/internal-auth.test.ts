import assert from 'node:assert/strict';
import {
  internalAuthHeaders,
  validateInternalBearer,
  isAuthStrict,
} from '../src/internal-auth.js';
import { describe, test } from 'vitest';

describe('internal-auth', () => {
  test('legacy assertions', () => {
    const prevToken = process.env['SRE_INTERNAL_TOKEN'];
    const prevStrict = process.env['SRE_AUTH_STRICT'];

    process.env['SRE_INTERNAL_TOKEN'] = 'test-secret-token';
    process.env['SRE_AUTH_STRICT'] = 'true';

    assert.equal(isAuthStrict(), true);
    assert.equal(validateInternalBearer('Bearer test-secret-token'), true);
    assert.equal(validateInternalBearer('Bearer wrong'), false);
    assert.equal(validateInternalBearer('Bearer wrong-length-token-xx'), false);
    assert.equal(validateInternalBearer(undefined), false);
    assert.equal(internalAuthHeaders()['Authorization'], 'Bearer test-secret-token');

    process.env['SRE_AUTH_STRICT'] = 'false';
    assert.equal(isAuthStrict(), false);

    if (prevToken === undefined) delete process.env['SRE_INTERNAL_TOKEN'];
    else process.env['SRE_INTERNAL_TOKEN'] = prevToken;
    if (prevStrict === undefined) delete process.env['SRE_AUTH_STRICT'];
    else process.env['SRE_AUTH_STRICT'] = prevStrict;
  });
});

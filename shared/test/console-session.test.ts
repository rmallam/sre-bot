import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { parseCookieHeader, sessionCookieName } from '../../agents/console/src/session-store.js';

describe('console session-store', () => {
  test('parseCookieHeader decodes values', () => {
    const cookies = parseCookieHeader('foo=bar; sre_console_sid=abc-123; baz=qux%20x');
    assert.equal(cookies['foo'], 'bar');
    assert.equal(cookies[sessionCookieName()], 'abc-123');
    assert.equal(cookies['baz'], 'qux x');
  });
});

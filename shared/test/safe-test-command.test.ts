import assert from 'node:assert/strict';
import { parseSafeTestCommand } from '../src/safe-test-command.js';
import { describe, test } from 'vitest';

describe('safe-test-command', () => {
  test('legacy assertions', () => {
    assert.ok(parseSafeTestCommand('npm test'));
    assert.equal(parseSafeTestCommand('npm test')?.cmd, 'npm');
    assert.ok(parseSafeTestCommand('go test ./...'));
    assert.ok(parseSafeTestCommand('pytest -q'));
    assert.equal(parseSafeTestCommand('rm -rf /'), null);
    assert.equal(parseSafeTestCommand('curl evil.com'), null);
    assert.equal(parseSafeTestCommand('sh -c whoami'), null);
    assert.equal(parseSafeTestCommand('npm run deploy'), null);
  });
});

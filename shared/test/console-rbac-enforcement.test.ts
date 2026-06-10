import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  CONSOLE_NAMESPACES_HEADER,
  hilEnforceConsoleRbac,
  hilNamespaceMutationAllowed,
} from '../src/console-rbac-enforcement.js';

describe('console-rbac-enforcement', () => {
  test('allows web mutation when namespace is permitted', () => {
    const prev = process.env['HIL_ENFORCE_CONSOLE_RBAC'];
    process.env['HIL_ENFORCE_CONSOLE_RBAC'] = 'true';
    const allowed = hilNamespaceMutationAllowed(
      { [CONSOLE_NAMESPACES_HEADER]: JSON.stringify(['team-ns']) },
      'team-ns',
      'web'
    );
    assert.equal(allowed, true);
    if (prev === undefined) delete process.env['HIL_ENFORCE_CONSOLE_RBAC'];
    else process.env['HIL_ENFORCE_CONSOLE_RBAC'] = prev;
  });

  test('telegram bypasses console RBAC header requirement', () => {
    const prev = process.env['HIL_ENFORCE_CONSOLE_RBAC'];
    process.env['HIL_ENFORCE_CONSOLE_RBAC'] = 'true';
    assert.equal(hilNamespaceMutationAllowed({}, 'any-ns', 'telegram'), true);
    if (prev === undefined) delete process.env['HIL_ENFORCE_CONSOLE_RBAC'];
    else process.env['HIL_ENFORCE_CONSOLE_RBAC'] = prev;
  });

  test('disabled by default', () => {
    const prev = process.env['HIL_ENFORCE_CONSOLE_RBAC'];
    delete process.env['HIL_ENFORCE_CONSOLE_RBAC'];
    assert.equal(hilEnforceConsoleRbac(), false);
    assert.equal(hilNamespaceMutationAllowed({}, 'secret-ns', 'web'), true);
    if (prev === undefined) delete process.env['HIL_ENFORCE_CONSOLE_RBAC'];
    else process.env['HIL_ENFORCE_CONSOLE_RBAC'] = prev;
  });
});

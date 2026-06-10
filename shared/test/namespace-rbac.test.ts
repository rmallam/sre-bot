import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  canAccessNamespace,
  filterByNamespaceAccess,
  hasGlobalNamespaceAccess,
  parseNamespaceRbacMap,
  resolveAllowedNamespaces,
  assertNamespaceAccess,
  NamespaceAccessDeniedError,
  type ConsoleUser,
} from '../src/namespace-rbac.js';

describe('namespace-rbac', () => {
  test('parseNamespaceRbacMap from CONSOLE_NAMESPACE_RBAC env', () => {
    const prev = process.env['CONSOLE_NAMESPACE_RBAC'];
    process.env['CONSOLE_NAMESPACE_RBAC'] = JSON.stringify({
      'team-a': ['ns-a', 'ns-b'],
      admins: ['*'],
    });
    const map = parseNamespaceRbacMap();
    assert.deepEqual(map['team-a'], ['ns-a', 'ns-b']);
    assert.deepEqual(map['admins'], ['*']);
    if (prev === undefined) delete process.env['CONSOLE_NAMESPACE_RBAC'];
    else process.env['CONSOLE_NAMESPACE_RBAC'] = prev;
  });

  test('resolveAllowedNamespaces merges group namespaces', () => {
    const prev = process.env['CONSOLE_NAMESPACE_RBAC'];
    process.env['CONSOLE_NAMESPACE_RBAC'] = JSON.stringify({
      'team-a': ['ns-a'],
      'team-b': ['ns-b'],
    });
    assert.deepEqual(resolveAllowedNamespaces(['team-a']), ['ns-a']);
    assert.deepEqual(resolveAllowedNamespaces(['team-a', 'team-b']), ['ns-a', 'ns-b']);
    if (prev === undefined) delete process.env['CONSOLE_NAMESPACE_RBAC'];
    else process.env['CONSOLE_NAMESPACE_RBAC'] = prev;
  });

  test('wildcard grants global access', () => {
    const user: ConsoleUser = {
      userId: 'admin',
      groups: ['admins'],
      allowedNamespaces: ['*'],
    };
    assert.equal(hasGlobalNamespaceAccess(user), true);
    assert.equal(canAccessNamespace(user, 'any-ns'), true);
  });

  test('filterByNamespaceAccess restricts items', () => {
    const user: ConsoleUser = {
      userId: 'dev',
      groups: ['team-a'],
      allowedNamespaces: ['ns-a'],
    };
    const items = [
      { id: '1', namespace: 'ns-a' },
      { id: '2', namespace: 'ns-b' },
    ];
    const filtered = filterByNamespaceAccess(user, items, (i) => i.namespace);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.id, '1');
  });

  test('assertNamespaceAccess throws on denied namespace', () => {
    const user: ConsoleUser = {
      userId: 'dev',
      groups: ['team-a'],
      allowedNamespaces: ['ns-a'],
    };
    assert.doesNotThrow(() => assertNamespaceAccess(user, 'ns-a'));
    assert.throws(
      () => assertNamespaceAccess(user, 'ns-b'),
      NamespaceAccessDeniedError
    );
  });
});

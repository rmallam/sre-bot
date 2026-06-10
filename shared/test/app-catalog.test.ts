import assert from 'node:assert/strict';
import {
  catalogKey,
  mergeCatalogEntries,
  type AppCatalogEntry,
} from '../src/app-catalog.js';
import { describe, test } from 'vitest';

describe('app-catalog', () => {
  test('legacy assertions', () => {
    const autoFrappe: AppCatalogEntry = {
      appId: 'frappe-operator',
      namespace: 'frappe-operator-system',
      source: 'auto',
      members: [
        { resourceKind: 'Deployment', resourceName: 'frappe-operator-controller-manager' },
        { resourceKind: 'Deployment', resourceName: 'keda-operator' },
      ],
      updatedAt: '2026-01-01T00:00:00.000Z',
      userEdited: false,
    };

    const userFrappe: AppCatalogEntry = {
      ...autoFrappe,
      source: 'user',
      userEdited: true,
      dependsOn: ['postgres'],
      members: [{ resourceKind: 'Deployment', resourceName: 'frappe-operator-controller-manager' }],
      updatedAt: '2026-02-01T00:00:00.000Z',
    };

    assert.equal(catalogKey('NS', 'App'), 'ns|app');

    const merged = mergeCatalogEntries([autoFrappe], [userFrappe]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.userEdited, true);
    assert.deepEqual(merged[0]!.dependsOn, ['postgres']);

    const autoOnly = mergeCatalogEntries([autoFrappe], []);
    assert.equal(autoOnly[0]!.members.length, 2);

    const userWinsOverAuto = mergeCatalogEntries([autoFrappe], [userFrappe, { ...autoFrappe, members: [] }]);
    assert.equal(userWinsOverAuto[0]!.members.length, 1);

    const emptyUserMembersKeepsAuto = mergeCatalogEntries(
      [autoFrappe],
      [{ ...userFrappe, userEdited: true, members: [] }]
    );
    assert.equal(emptyUserMembersKeepsAuto[0]!.members.length, 2);
  });
});

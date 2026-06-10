import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, test } from 'vitest';

describe('app-catalog-store', () => {
  test('legacy assertions', async () => {
    process.env['APP_CATALOG_PATH'] = join(tmpdir(), `catalog-test-${Date.now()}.json`);

    const {
      upsertAutoCatalogEntry,
      upsertCatalogEntry,
      getCatalogEntry,
      deleteCatalogEntry,
      listCatalogEntries,
      resetCatalogCache,
    } = await import('../src/app-catalog-store.js');

    const dir = await mkdtemp(join(tmpdir(), 'sre-catalog-'));
    const catalogPath = join(dir, 'catalog.json');
    process.env['APP_CATALOG_PATH'] = catalogPath;
    resetCatalogCache();

    await upsertAutoCatalogEntry({
      appId: 'frappe-operator',
      namespace: 'frappe-operator-system',
      members: [
        { resourceKind: 'Deployment', resourceName: 'frappe-operator-controller-manager' },
        { resourceKind: 'Deployment', resourceName: 'keda-operator' },
      ],
    });

    let entry = await getCatalogEntry('frappe-operator-system', 'frappe-operator');
    assert.ok(entry);
    assert.equal(entry!.source, 'auto');
    assert.equal(entry!.members.length, 2);

    await upsertCatalogEntry({
      appId: 'frappe-operator',
      namespace: 'frappe-operator-system',
      source: 'user',
      userEdited: true,
      members: [{ resourceKind: 'Deployment', resourceName: 'frappe-operator-controller-manager' }],
      dependsOn: ['postgres'],
      updatedAt: new Date().toISOString(),
    });

    const blocked = await upsertAutoCatalogEntry({
      appId: 'frappe-operator',
      namespace: 'frappe-operator-system',
      members: [{ resourceKind: 'Deployment', resourceName: 'keda-operator' }],
    });
    assert.equal(blocked!.userEdited, true);
    assert.equal(blocked!.members.length, 1);

    const all = await listCatalogEntries();
    assert.equal(all.length, 1);

    const deleted = await deleteCatalogEntry('frappe-operator-system', 'frappe-operator');
    assert.equal(deleted, true);
    assert.equal((await listCatalogEntries()).length, 0);

    await rm(dir, { recursive: true, force: true });
  });
});

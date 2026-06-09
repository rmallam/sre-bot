import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectDeployEntryPoint,
  isNonK8sYamlFile,
  isHelmChartPath,
} from '../src/deploy/entry-point.js';

assert.equal(isNonK8sYamlFile('compose.yml'), true);
assert.equal(isNonK8sYamlFile('deployment.yaml'), false);
assert.equal(isHelmChartPath('helm/frappe-operator/Chart.yaml'), true);

function tempRepo(layout: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'sre-entry-'));
  layout(root);
  return root;
}

const composeOnly = tempRepo((root) => {
  writeFileSync(join(root, 'compose.yml'), 'services:\n  web:\n    image: nginx\n');
  writeFileSync(join(root, 'README.md'), '# app\n');
});
const composeEntry = detectDeployEntryPoint(composeOnly);
assert.equal(composeEntry, null, 'compose-only repo should not pick compose.yml');

const frappeLike = tempRepo((root) => {
  writeFileSync(join(root, 'compose.yml'), 'services:\n  web:\n    image: nginx\n');
  mkdirSync(join(root, 'helm', 'frappe-operator'), { recursive: true });
  writeFileSync(join(root, 'helm', 'frappe-operator', 'Chart.yaml'), 'apiVersion: v2\nname: frappe-operator\n');
  writeFileSync(join(root, 'install.yaml'), 'apiVersion: v1\nkind: Namespace\n');
});
const frappeEntry = detectDeployEntryPoint(frappeLike, 'frappe-operator');
assert.ok(frappeEntry);
assert.equal(frappeEntry.kind, 'helm');
assert.ok(frappeEntry.path.endsWith('helm/frappe-operator/Chart.yaml'));

const installOnly = tempRepo((root) => {
  writeFileSync(join(root, 'install.yaml'), 'apiVersion: v1\nkind: List\n');
});
const installEntry = detectDeployEntryPoint(installOnly);
assert.equal(installEntry?.kind, 'operator-install');

console.log('deploy-entry-point.test.ts ok');

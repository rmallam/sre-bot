import assert from 'node:assert/strict';
import { parseReadmeInstallHints } from '../src/deploy/readme-install-hints.js';

const helmReadme = `
## Install

\`\`\`bash
helm upgrade --install frappe-operator ./helm/frappe-operator -n frappe-operator-system --create-namespace
\`\`\`
`;
const helmHints = parseReadmeInstallHints(helmReadme);
assert.ok(helmHints);
assert.equal(helmHints.method, 'helm');
assert.equal(helmHints.chartPath, 'helm/frappe-operator');

const kubectlReadme = `
kubectl apply -f config/manager/manager.yaml
`;
const kubectlHints = parseReadmeInstallHints(kubectlReadme);
assert.ok(kubectlHints);
assert.equal(kubectlHints.method, 'kubectl');
assert.equal(kubectlHints.manifestPath, 'config/manager/manager.yaml');

const installYamlReadme = 'See install.yaml for the operator bundle.';
const installHints = parseReadmeInstallHints(installYamlReadme);
assert.ok(installHints);
assert.equal(installHints.method, 'kubectl');
assert.equal(installHints.manifestPath, 'install.yaml');

assert.equal(parseReadmeInstallHints(''), null);
assert.equal(parseReadmeInstallHints('   '), null);

console.log('readme-install-hints.test.ts: ok');

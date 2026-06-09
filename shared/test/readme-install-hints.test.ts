import assert from 'node:assert/strict';
import {
  isLocalHelmChartPath,
  parseReadmeInstallHints,
  resolveDeployManifestPath,
} from '../src/deploy/readme-install-hints.js';

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
assert.equal(helmHints.remoteHelmRepo, false);

const frappeRemoteReadme = `
# Or install with Helm
helm repo add frappe-operator https://vyogotech.github.io/frappe-operator/helm-repo
helm install frappe-operator frappe-operator/frappe-operator \\
  --namespace frappe-operator-system \\
  --create-namespace
`;
const remoteHints = parseReadmeInstallHints(frappeRemoteReadme);
assert.ok(remoteHints);
assert.equal(remoteHints.method, 'helm');
assert.equal(remoteHints.remoteHelmRepo, true);
assert.equal(remoteHints.remoteHelm?.repoName, 'frappe-operator');
assert.ok(remoteHints.remoteHelm?.repoUrl.includes('vyogotech.github.io'));
assert.equal(remoteHints.remoteHelm?.chartRef, 'frappe-operator/frappe-operator');
assert.equal(remoteHints.chartPath, undefined);
assert.equal(isLocalHelmChartPath('frappe-operator/frappe-operator'), false);
assert.equal(isLocalHelmChartPath('helm/frappe-operator'), true);

const resolved = resolveDeployManifestPath({
  detectedManifestPath: 'helm/frappe-operator/Chart.yaml',
  readmeHints: remoteHints,
});
assert.equal(resolved.source, 'detected');
assert.equal(resolved.manifestPath, 'helm/frappe-operator/Chart.yaml');

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

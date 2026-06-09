import assert from 'node:assert/strict';
import {
  ENTERPRISE_DEPLOY_SCENARIO_MATRIX,
  applyEnterpriseProfile,
  classifyEnterpriseDeployScenario,
} from '../src/deploy/enterprise-scenarios.js';
import type { DiagnosisContext, RemediationPlan, StartRunRequest } from '../src/types.js';

function baseRequest(overrides: Partial<StartRunRequest> = {}): StartRunRequest {
  return {
    incidentId: 'inc-1',
    mode: 'pre-deploy',
    namespace: 'demo',
    resourceName: 'myapp',
    githubRepo: 'github.com/acme/myapp',
    gitRef: 'main',
    ...overrides,
  };
}

function baseCtx(overrides: Partial<DiagnosisContext> = {}): DiagnosisContext {
  return {
    incidentId: 'inc-1',
    mode: 'pre-deploy',
    namespace: 'demo',
    resourceName: 'myapp',
    podSpec: {},
    containerStatuses: [],
    resourceLimits: {},
    recentEvents: [],
    currentLogs: '',
    previousLogs: '',
    ...overrides,
  } as DiagnosisContext;
}

const catalog = classifyEnterpriseDeployScenario({
  ctx: baseCtx(),
  request: baseRequest({ containerImage: 'nginx:1.25' }),
});
assert.equal(catalog.scenario, 'catalog-image');
assert.equal(catalog.recommendedAction, 'repo_apply');

const prevArgo = process.env['ARGOCD_URL'];
process.env['ARGOCD_URL'] = 'https://argocd.example.com';

const helmExisting = classifyEnterpriseDeployScenario({
  ctx: baseCtx({
    gitManifestPath: 'helm/myapp/Chart.yaml',
    repoEntryPointKind: 'helm',
    needsHelmGeneration: false,
  }),
  request: baseRequest({ deployStrategy: 'gitops' }),
  assumeNoArgo: false,
});
assert.equal(helmExisting.scenario, 'helm-existing');
assert.equal(helmExisting.recommendedAction, 'helm_deploy');

if (prevArgo === undefined) delete process.env['ARGOCD_URL'];
else process.env['ARGOCD_URL'] = prevArgo;

const helmDirect = classifyEnterpriseDeployScenario({
  ctx: baseCtx({
    gitManifestPath: 'helm/myapp/Chart.yaml',
    repoEntryPointKind: 'helm',
    needsHelmGeneration: false,
  }),
  request: baseRequest({ deployStrategy: 'direct' }),
});
assert.equal(helmDirect.scenario, 'helm-existing');
assert.equal(helmDirect.recommendedAction, 'repo_apply');

const operator = classifyEnterpriseDeployScenario({
  ctx: baseCtx({
    gitManifestPath: 'install.yaml',
    repoEntryPointKind: 'operator-install',
  }),
  request: baseRequest(),
});
assert.equal(operator.scenario, 'operator-bundle');
assert.equal(operator.recommendedAction, 'repo_apply');

const readmeHelm = classifyEnterpriseDeployScenario({
  ctx: baseCtx({ needsHelmGeneration: true }),
  request: baseRequest(),
  readmeHints: { method: 'helm', chartPath: 'charts/app' },
});
assert.equal(readmeHelm.scenario, 'readme-guided-helm');
assert.equal(readmeHelm.manifestPath, 'charts/app/Chart.yaml');

const prod = classifyEnterpriseDeployScenario({
  ctx: baseCtx({ namespaceExists: false }),
  request: baseRequest({ namespace: 'production' }),
});
assert.ok(prod.tags.includes('prod-hil-gate'));
assert.ok(prod.tags.includes('namespace-missing'));
assert.equal(prod.requiresHil, true);

const basePlan: RemediationPlan = {
  action: 'git_patch',
  rootCause: 'test',
  reasoning: 'legacy',
  severity: 'LOW',
  proposedPatch: [{ op: 'replace', path: '/spec/replicas', value: 1 }],
  targetManifestPath: 'deploy.yaml',
  commitMessage: 'test',
  rollbackSafe: true,
};
const applied = applyEnterpriseProfile(operator, basePlan, {
  githubRepo: 'github.com/acme/op',
  gitRef: 'main',
});
assert.equal(applied.action, 'repo_apply');
assert.equal(applied.targetManifestPath, 'install.yaml');
assert.deepEqual(applied.proposedPatch, []);

assert.equal(ENTERPRISE_DEPLOY_SCENARIO_MATRIX.length, 17);

console.log('enterprise-scenarios.test.ts: ok');

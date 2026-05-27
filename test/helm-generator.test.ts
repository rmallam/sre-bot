import { describe, expect, it } from 'vitest';
import { buildHelmDeployPlan, generateHelmChart, defaultChartPath } from '../shared/src/helm-generator.js';

describe('helm-generator', () => {
  it('creates chart files under deploy/helm/<app>', () => {
    const chart = generateHelmChart({
      appName: 'My-App',
      namespace: 'staging',
      githubRepo: 'github.com/acme/my-app',
      repoSignals: { hasPackageJson: true, hasDockerfile: true, primaryLanguage: 'nodejs' },
    });
    const base = defaultChartPath('my-app');
    expect(chart.files[`${base}/Chart.yaml`]).toContain('name: my-app');
    expect(chart.files[`${base}/values.yaml`]).toContain('namespace: staging');
    expect(chart.files[`${base}/templates/deployment.yaml`]).toContain('kind: Deployment');
  });

  it('buildHelmDeployPlan sets helm_deploy action and githubRepo', () => {
    const plan = buildHelmDeployPlan({
      appName: 'api',
      namespace: 'default',
      githubRepo: 'github.com/acme/api',
      gitRef: 'main',
    });
    expect(plan.action).toBe('helm_deploy');
    expect(plan.githubRepo).toBe('github.com/acme/api');
    expect(plan.helmChart?.files).toBeDefined();
    expect(Object.keys(plan.helmChart!.files).length).toBeGreaterThan(0);
  });
});

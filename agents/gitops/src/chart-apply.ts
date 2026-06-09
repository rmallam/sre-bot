/**
 * Deploy Helm charts with intelligent fallbacks:
 * - Preflight cluster connectivity; auto-fix TLS/kubeconfig when possible
 * - Only try alternate deploy paths when failure is tooling/manifest-related,
 *   not when the API server is unreachable (helm uses the same connection as kubectl).
 */

import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import type { DeployNotifyTarget } from '../../../shared/src/deploy-notify.js';
import { sendDeployProgress } from '../../../shared/src/deploy-notify.js';
import {
  classifyDeployFailure,
  type DeployFailureAnalysis,
} from '../../../shared/src/deploy-failure.js';
import {
  probeClusterConnectivity,
  remediateKubeconfigInsecureTls,
  isInClusterKube,
} from '../../../shared/src/kube-connectivity.js';
import { log } from '../../../shared/src/http.js';
import { ensureNamespace } from './ensure-namespace.js';

const execFile = promisify(execFileCb);

export interface ChartApplyOpts {
  chartDir: string;
  releaseName: string;
  namespace: string;
  incidentId: string;
  dryRun?: boolean;
  createNamespace?: boolean;
  notify?: DeployNotifyTarget;
}

async function progress(opts: ChartApplyOpts, message: string): Promise<void> {
  if (opts.notify) await sendDeployProgress(opts.notify, message);
}

async function runCmd(
  cmd: string,
  args: string[],
  incidentId: string
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFile(cmd, args, {
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
  });
  log('info', 'gitops-agent', `Chart deploy command OK: ${cmd}`, {
    incidentId,
    args: args.slice(0, 8).join(' '),
    stdout: stdout?.slice(0, 2000),
    stderr: stderr?.slice(0, 1000),
  });
  return { stdout: stdout ?? '', stderr: stderr ?? '' };
}

function analyze(err: unknown): DeployFailureAnalysis {
  return classifyDeployFailure(err);
}

async function ensureClusterReachable(opts: ChartApplyOpts): Promise<void> {
  await progress(opts, 'Checking connection to the Kubernetes API…');

  try {
    await probeClusterConnectivity(opts.incidentId);
    await progress(opts, 'Cluster API is reachable.');
    return;
  } catch (firstErr) {
    const analysis = analyze(firstErr);
    if (analysis.kind !== 'cluster_unreachable') {
      throw enrichError(firstErr, analysis);
    }

    await progress(
      opts,
      isInClusterKube()
        ? 'API connection failed from inside the cluster. Retrying…'
        : 'API connection failed (TLS/host mismatch). Adjusting kubeconfig (skip TLS verify for forwarded API) and retrying…'
    );

    try {
      const clusters = await remediateKubeconfigInsecureTls();
      if (clusters.length > 0) {
        log('info', 'gitops-agent', 'Patched kubeconfig clusters for TLS', {
          incidentId: opts.incidentId,
          clusters,
        });
      }
      await probeClusterConnectivity(opts.incidentId);
      await progress(opts, 'Cluster API is reachable after kubeconfig fix.');
      return;
    } catch (secondErr) {
      const second = analyze(secondErr);
      const hint = isInClusterKube()
        ? 'Check gitops-agent RBAC and kubectl client version in the gitops image.'
        : `Ensure Podman can reach your cluster API (KUBE_API_HOST=${process.env['KUBE_API_HOST'] ?? 'host.containers.internal'}) ` +
          `or enable compose profile kube-proxy.`;
      throw new Error(
        `${analysis.summary} Automatic fix did not help. ${hint} Detail: ${String(secondErr).slice(0, 280)}`
      );
    }
  }
}

function enrichError(err: unknown, analysis: DeployFailureAnalysis): Error {
  const detail = String(err).slice(0, 400);
  return new Error(`${analysis.summary} ${detail}`);
}

async function handleDeployError(
  opts: ChartApplyOpts,
  err: unknown,
  context: string
): Promise<never> {
  const analysis = analyze(err);
  log('warn', 'gitops-agent', `Deploy step failed: ${context}`, {
    incidentId: opts.incidentId,
    kind: analysis.kind,
    alternateStrategyMayHelp: analysis.alternateStrategyMayHelp,
    error: String(err).slice(0, 500),
  });

  if (!analysis.alternateStrategyMayHelp) {
    await progress(
      opts,
      `Stopping deploy: ${analysis.summary} (not retrying Helm — same cluster connection).`
    );
    throw enrichError(err, analysis);
  }

  throw err;
}

async function helmUsable(opts: ChartApplyOpts): Promise<boolean> {
  try {
    await runCmd('helm', ['version', '--short'], opts.incidentId);
    return true;
  } catch (err) {
    const analysis = analyze(err);
    log('warn', 'gitops-agent', 'Helm binary unavailable or crashed', {
      incidentId: opts.incidentId,
      kind: analysis.kind,
      error: String(err).slice(0, 300),
    });
    if (analysis.kind === 'helm_tooling') {
      await progress(
        opts,
        `${analysis.summary} Will try kubectl manifest apply instead.`
      );
      return false;
    }
    await handleDeployError(opts, err, 'helm version');
    return false;
  }
}

function isGeneratedSreChart(chartDir: string): boolean {
  return (
    existsSync(join(chartDir, 'values.yaml')) &&
    existsSync(join(chartDir, 'templates', 'deployment.yaml'))
  );
}

interface ChartValues {
  replicaCount?: number;
  image?: { repository?: string; tag?: string; pullPolicy?: string };
  service?: { type?: string; port?: number };
  resources?: Record<string, unknown>;
}

async function applyPlainFromValues(opts: ChartApplyOpts): Promise<void> {
  await progress(
    opts,
    `Applying Kubernetes manifests with kubectl (namespace ${opts.namespace}, app ${opts.releaseName})…`
  );

  const valuesRaw = await readFile(join(opts.chartDir, 'values.yaml'), 'utf-8');
  const values = YAML.parse(valuesRaw) as ChartValues;
  const replicas = values.replicaCount ?? 1;
  const imageRepo = values.image?.repository ?? 'nginx';
  const imageTag = values.image?.tag ?? 'latest';
  const pullPolicy = values.image?.pullPolicy ?? 'IfNotPresent';
  const port = values.service?.port ?? 8080;
  const svcType = values.service?.type ?? 'ClusterIP';
  const name = opts.releaseName;
  const ns = opts.namespace;

  const docs = [
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: ns },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace: ns, labels: appLabels(name) },
      spec: {
        replicas,
        selector: { matchLabels: appLabels(name) },
        template: {
          metadata: { labels: appLabels(name) },
          spec: {
            containers: [
              {
                name,
                image: `${imageRepo}:${imageTag}`,
                imagePullPolicy: pullPolicy,
                ports: [{ containerPort: port }],
                resources: values.resources,
              },
            ],
          },
        },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, namespace: ns, labels: appLabels(name) },
      spec: {
        type: svcType,
        selector: appLabels(name),
        ports: [{ port, targetPort: port, protocol: 'TCP', name: 'http' }],
      },
    },
  ];

  const manifest = docs.map((d) => YAML.stringify(d)).join('---\n');
  const tmp = await mkdtemp(join(tmpdir(), 'sre-plain-'));
  const manifestPath = join(tmp, 'manifest.yaml');
  await writeFile(manifestPath, manifest, 'utf-8');

  if (opts.dryRun) {
    await progress(opts, 'Dry-run: validating manifests against the API server…');
    await runCmd(
      'kubectl',
      ['apply', '-f', manifestPath, '--dry-run=server'],
      opts.incidentId
    );
  }

  await progress(opts, `Creating namespace ${ns} (if needed) and applying Deployment + Service…`);
  await runCmd('kubectl', ['apply', '-f', manifestPath], opts.incidentId);
  await progress(opts, `Manifests applied. Check: oc get pods -n ${ns}`);
}

function appLabels(name: string): Record<string, string> {
  return {
    'app.kubernetes.io/name': name,
    'app.kubernetes.io/instance': name,
    'app.kubernetes.io/managed-by': 'sre-bot',
  };
}

async function applyHelmTemplate(opts: ChartApplyOpts): Promise<void> {
  await progress(opts, 'Rendering chart with helm template, then kubectl apply…');
  const { stdout } = await runCmd(
    'helm',
    [
      'template',
      opts.releaseName,
      opts.chartDir,
      '--namespace',
      opts.namespace,
      '--create-namespace',
    ],
    opts.incidentId
  );
  const renderedDir = await mkdtemp(join(tmpdir(), 'sre-helm-render-'));
  const renderedPath = join(renderedDir, 'manifest.yaml');
  await writeFile(renderedPath, stdout, 'utf-8');

  if (opts.dryRun) {
    await runCmd(
      'kubectl',
      ['apply', '-f', renderedPath, '--dry-run=server', '-n', opts.namespace],
      opts.incidentId
    );
  }
  await progress(opts, `Applying rendered chart to namespace ${opts.namespace}…`);
  await runCmd(
    'kubectl',
    ['apply', '-f', renderedPath, '-n', opts.namespace],
    opts.incidentId
  );
  await progress(opts, `Helm template + kubectl apply finished for ${opts.namespace}.`);
}

async function applyHelmUpgrade(opts: ChartApplyOpts): Promise<void> {
  await progress(opts, `Installing with helm upgrade --install in ${opts.namespace}…`);
  const base = [
    'upgrade',
    '--install',
    opts.releaseName,
    opts.chartDir,
    '--namespace',
    opts.namespace,
    '--create-namespace',
  ];
  if (opts.dryRun) {
    await runCmd('helm', [...base, '--dry-run'], opts.incidentId);
  }
  await runCmd('helm', base, opts.incidentId);
  await progress(opts, `Helm release ${opts.releaseName} installed in ${opts.namespace}.`);
}

export async function applyHelmChartWithFallbacks(opts: ChartApplyOpts): Promise<string> {
  if (opts.createNamespace) {
    await ensureNamespace({
      namespace: opts.namespace,
      incidentId: opts.incidentId,
      notify: opts.notify,
    });
  }

  await ensureClusterReachable(opts);

  if (isGeneratedSreChart(opts.chartDir)) {
    try {
      await applyPlainFromValues(opts);
      return 'kubectl-from-values';
    } catch (err) {
      const analysis = analyze(err);
      if (!analysis.alternateStrategyMayHelp) {
        await handleDeployError(opts, err, 'kubectl-from-values');
      }
      await progress(
        opts,
        `kubectl apply failed (${analysis.summary}) — trying Helm only because this may be a chart/render issue.`
      );
    }
  }

  const helmOk = await helmUsable(opts);
  if (!helmOk && isGeneratedSreChart(opts.chartDir)) {
    throw new Error('kubectl apply failed and Helm is not usable in this container.');
  }

  if (helmOk) {
    try {
      await applyHelmTemplate(opts);
      return 'helm-template-kubectl';
    } catch (err) {
      const analysis = analyze(err);
      if (!analysis.alternateStrategyMayHelp) {
        await handleDeployError(opts, err, 'helm-template');
      }
      await progress(opts, 'Helm template path failed — trying helm upgrade (release install)…');
    }

    try {
      await applyHelmUpgrade(opts);
      return 'helm-upgrade';
    } catch (err) {
      await handleDeployError(opts, err, 'helm-upgrade');
    }
  }

  throw new Error('No deploy method succeeded.');
}

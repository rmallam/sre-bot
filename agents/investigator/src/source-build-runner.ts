/**
 * In-cluster source builds (DEPLOY-2b/c) — Kaniko, pack, OpenShift S2I.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as k8s from '@kubernetes/client-node';
import { shallowCloneRepo } from './git-clone.js';
import {
  defaultBuiltImageRef,
  type SourceBuildResult,
} from '../../../shared/src/deploy/source-build.js';
import {
  defaultBuilderImage,
  type DetectedRuntime,
  type SourceBuildStrategy,
} from '../../../shared/src/deploy/runtime-detect.js';
import { toHttpsCloneUrl } from '../../../shared/src/git-ref.js';
import { log } from '../../../shared/src/http.js';

const execFile = promisify(execFileCb);
const AGENT = 'investigator';

function buildKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token')) {
    try {
      kc.loadFromCluster();
      return kc;
    } catch {}
  }
  kc.loadFromDefault();
  return kc;
}

const kc = buildKubeConfig();
const batchApi = kc.makeApiClient(k8s.BatchV1Api);
const coreApi = kc.makeApiClient(k8s.CoreV1Api);

export interface BuildFromSourceRequest {
  incidentId: string;
  appName: string;
  namespace: string;
  githubRepo: string;
  gitRef: string;
  runtime?: DetectedRuntime;
  strategy?: SourceBuildStrategy;
}

function buildNamespace(targetNamespace: string): string {
  return (
    process.env['SOURCE_BUILD_NAMESPACE'] ??
    process.env['BUILD_NAMESPACE'] ??
    targetNamespace
  );
}

function jobName(incidentId: string): string {
  const slug = incidentId.replace(/[^a-z0-9-]/gi, '').slice(0, 12).toLowerCase();
  return `sre-build-${slug}-${Date.now().toString(36)}`.slice(0, 63);
}

function gitCloneInitContainer(repoUrl: string, gitRef: string): k8s.V1Container {
  const cloneUrl = toHttpsCloneUrl(repoUrl);
  const token = process.env['GITHUB_TOKEN'] ?? '';
  const env: k8s.V1EnvVar[] = [
    { name: 'GIT_TERMINAL_PROMPT', value: '0' },
    { name: 'GIT_ASKPASS', value: 'echo' },
  ];
  if (token) {
    env.push({ name: 'GITHUB_TOKEN', value: token });
  }
  const cloneScript = token
    ? `git clone --depth 1 --branch "${gitRef}" "https://x-access-token:${token}@${cloneUrl.replace(/^https?:\/\//, '')}" /workspace`
    : `git clone --depth 1 --branch "${gitRef}" "${cloneUrl}" /workspace`;

  return {
    name: 'git-clone',
    image: process.env['GIT_CLONE_IMAGE'] ?? 'alpine/git:2.45.2',
    command: ['sh', '-c'],
    args: [cloneScript],
    env,
    volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }],
  };
}

async function waitForJob(namespace: string, name: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await batchApi.readNamespacedJobStatus(name, namespace);
    const status = res.body.status;
    if ((status?.succeeded ?? 0) > 0) return;
    if ((status?.failed ?? 0) > 0) {
      const logs = await readJobPodLogs(namespace, name).catch(() => '');
      throw new Error(`Build job failed${logs ? `: ${logs.slice(-800)}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`Build job timed out after ${Math.round(timeoutMs / 60_000)} minutes`);
}

async function readJobPodLogs(namespace: string, jobName: string): Promise<string> {
  const pods = await coreApi.listNamespacedPod(
    namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    `job-name=${jobName}`
  );
  const pod = pods.body.items[0];
  const podName = pod?.metadata?.name;
  if (!podName) return '';
  const logRes = await coreApi.readNamespacedPodLog(
    podName,
    namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    200,
    true
  );
  return typeof logRes.body === 'string' ? logRes.body : String(logRes.body ?? '');
}

async function runKanikoJob(opts: {
  incidentId: string;
  namespace: string;
  githubRepo: string;
  gitRef: string;
  image: string;
}): Promise<string> {
  const buildNs = buildNamespace(opts.namespace);
  const name = jobName(opts.incidentId);
  const kanikoImage = process.env['KANIKO_IMAGE'] ?? 'gcr.io/kaniko-project/executor:v1.23.2';
  const pushSecret = process.env['IMAGE_PUSH_SECRET'];
  const extraArgs = (process.env['KANIKO_EXTRA_ARGS'] ?? '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const job: k8s.V1Job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name,
      namespace: buildNs,
      labels: {
        'app.kubernetes.io/managed-by': 'sre-bot',
        'sre-bot/build-for': opts.incidentId,
      },
    },
    spec: {
      ttlSecondsAfterFinished: 3600,
      backoffLimit: 0,
      template: {
        metadata: { labels: { 'job-name': name } },
        spec: {
          restartPolicy: 'Never',
          initContainers: [gitCloneInitContainer(opts.githubRepo, opts.gitRef)],
          containers: [
            {
              name: 'kaniko',
              image: kanikoImage,
              args: [
                '--dockerfile=Dockerfile',
                '--context=dir:///workspace',
                `--destination=${opts.image}`,
                ...extraArgs,
              ],
              volumeMounts: [
                { name: 'workspace', mountPath: '/workspace' },
                ...(pushSecret
                  ? [{ name: 'docker-config', mountPath: '/kaniko/.docker' }]
                  : []),
              ],
            },
          ],
          volumes: [
            { name: 'workspace', emptyDir: {} },
            ...(pushSecret
              ? [{ name: 'docker-config', secret: { secretName: pushSecret } }]
              : []),
          ],
        },
      },
    },
  };

  log('info', AGENT, 'Creating Kaniko build job', {
    incidentId: opts.incidentId,
    namespace: buildNs,
    job: name,
    image: opts.image,
  });

  await batchApi.createNamespacedJob(buildNs, job);
  const timeoutMs = parseInt(process.env['SOURCE_BUILD_TIMEOUT_MS'] ?? '900000', 10);
  await waitForJob(buildNs, name, timeoutMs);
  return opts.image;
}

async function runPackLocal(opts: {
  repoDir: string;
  image: string;
  runtime: DetectedRuntime;
}): Promise<void> {
  const packPath = process.env['PACK_CLI_PATH'];
  if (!packPath) throw new Error('PACK_CLI_PATH not configured');

  const builder = defaultBuilderImage(opts.runtime);
  if (!builder) throw new Error(`No buildpack builder configured for runtime ${opts.runtime}`);

  const args = [
    'build',
    opts.image,
    '--path',
    opts.repoDir,
    '--builder',
    builder,
    '--publish',
    '--trust-builder',
  ];
  if (process.env['PACK_EXTRA_ARGS']) {
    args.push(...process.env['PACK_EXTRA_ARGS'].split(/\s+/).filter(Boolean));
  }

  await execFile(packPath, args, {
    timeout: parseInt(process.env['SOURCE_BUILD_TIMEOUT_MS'] ?? '900000', 10),
    env: { ...process.env },
  });
}

async function runPackJob(opts: {
  incidentId: string;
  namespace: string;
  githubRepo: string;
  gitRef: string;
  image: string;
  runtime: DetectedRuntime;
}): Promise<string> {
  const builder = defaultBuilderImage(opts.runtime);
  if (!builder) throw new Error(`No buildpack builder for runtime ${opts.runtime}`);

  const buildNs = buildNamespace(opts.namespace);
  const name = jobName(opts.incidentId);
  const packImage = process.env['PACK_JOB_IMAGE'] ?? 'buildpacksio/pack:0.35.1';
  const pushSecret = process.env['IMAGE_PUSH_SECRET'];

  const job: k8s.V1Job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name,
      namespace: buildNs,
      labels: {
        'app.kubernetes.io/managed-by': 'sre-bot',
        'sre-bot/build-for': opts.incidentId,
      },
    },
    spec: {
      ttlSecondsAfterFinished: 3600,
      backoffLimit: 0,
      template: {
        metadata: { labels: { 'job-name': name } },
        spec: {
          restartPolicy: 'Never',
          initContainers: [gitCloneInitContainer(opts.githubRepo, opts.gitRef)],
          containers: [
            {
              name: 'pack',
              image: packImage,
              command: ['pack'],
              args: [
                'build',
                opts.image,
                '--path',
                '/workspace',
                '--builder',
                builder,
                '--publish',
                '--trust-builder',
              ],
              env: [{ name: 'CNB_PLATFORM_API', value: '0.12' }],
              volumeMounts: [
                { name: 'workspace', mountPath: '/workspace' },
                ...(pushSecret
                  ? [{ name: 'docker-config', mountPath: '/root/.docker' }]
                  : []),
              ],
            },
          ],
          volumes: [
            { name: 'workspace', emptyDir: {} },
            ...(pushSecret
              ? [{ name: 'docker-config', secret: { secretName: pushSecret } }]
              : []),
          ],
        },
      },
    },
  };

  log('info', AGENT, 'Creating pack build job', {
    incidentId: opts.incidentId,
    namespace: buildNs,
    job: name,
    image: opts.image,
    builder,
  });

  await batchApi.createNamespacedJob(buildNs, job);
  const timeoutMs = parseInt(process.env['SOURCE_BUILD_TIMEOUT_MS'] ?? '900000', 10);
  await waitForJob(buildNs, name, timeoutMs);
  return opts.image;
}

async function runOpenShiftS2I(opts: {
  incidentId: string;
  namespace: string;
  githubRepo: string;
  gitRef: string;
  image: string;
  runtime: DetectedRuntime;
}): Promise<string> {
  const apiUrl = process.env['OPENSHIFT_API_URL'];
  if (!apiUrl) {
    throw new Error('OPENSHIFT_API_URL not configured');
  }

  const builderMap: Partial<Record<DetectedRuntime, string>> = {
    nodejs: process.env['S2I_NODEJS_BUILDER'] ?? 'registry.redhat.io/ubi9/nodejs-20:latest',
    python: process.env['S2I_PYTHON_BUILDER'] ?? 'registry.redhat.io/ubi9/python-311:latest',
    go: process.env['S2I_GO_BUILDER'] ?? 'registry.redhat.io/ubi9/go-toolset:latest',
    java: process.env['S2I_JAVA_BUILDER'] ?? 'registry.redhat.io/ubi9/openjdk-17:latest',
    ruby: process.env['S2I_RUBY_BUILDER'] ?? 'registry.redhat.io/ubi9/ruby-33:latest',
  };
  const builderImage = builderMap[opts.runtime];
  if (!builderImage) {
    throw new Error(`No S2I builder image for runtime ${opts.runtime}`);
  }

  const cloneUrl = toHttpsCloneUrl(opts.githubRepo);
  const buildName = jobName(opts.incidentId);
  const targetNs = buildNamespace(opts.namespace);

  const buildConfig = {
    apiVersion: 'build.openshift.io/v1',
    kind: 'BuildConfig',
    metadata: {
      name: buildName,
      namespace: targetNs,
      labels: { 'app.kubernetes.io/managed-by': 'sre-bot' },
    },
    spec: {
      source: {
        type: 'Git',
        git: { uri: cloneUrl, ref: opts.gitRef },
      },
      strategy: {
        type: 'Source',
        sourceStrategy: {
          from: { kind: 'DockerImage', name: builderImage },
        },
      },
      output: {
        to: { kind: 'DockerImage', name: opts.image },
        pushSecret: process.env['IMAGE_PUSH_SECRET']
          ? { name: process.env['IMAGE_PUSH_SECRET'] }
          : undefined,
      },
      triggers: [],
    },
  };

  const token = process.env['OPENSHIFT_TOKEN'] ?? process.env['GITHUB_TOKEN'] ?? '';
  const res = await fetch(`${apiUrl.replace(/\/$/, '')}/apis/build.openshift.io/v1/namespaces/${targetNs}/buildconfigs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(buildConfig),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenShift BuildConfig create failed: HTTP ${res.status} ${body.slice(0, 400)}`);
  }

  const startRes = await fetch(
    `${apiUrl.replace(/\/$/, '')}/apis/build.openshift.io/v1/namespaces/${targetNs}/buildconfigs/${buildName}/instantiate`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!startRes.ok) {
    const body = await startRes.text().catch(() => '');
    throw new Error(`OpenShift build start failed: HTTP ${startRes.status} ${body.slice(0, 400)}`);
  }

  const build = (await startRes.json()) as { metadata?: { name?: string } };
  const openshiftBuild = build.metadata?.name ?? buildName;
  const deadline = Date.now() + parseInt(process.env['SOURCE_BUILD_TIMEOUT_MS'] ?? '900000', 10);

  while (Date.now() < deadline) {
    const statusRes = await fetch(
      `${apiUrl.replace(/\/$/, '')}/apis/build.openshift.io/v1/namespaces/${targetNs}/builds/${openshiftBuild}`,
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!statusRes.ok) throw new Error(`OpenShift build status failed: HTTP ${statusRes.status}`);
    const statusBody = (await statusRes.json()) as {
      status?: { phase?: string; message?: string };
    };
    const phase = statusBody.status?.phase;
    if (phase === 'Complete') return opts.image;
    if (phase === 'Failed' || phase === 'Cancelled' || phase === 'Error') {
      throw new Error(statusBody.status?.message ?? `OpenShift build ${phase}`);
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }

  throw new Error('OpenShift S2I build timed out');
}

export async function buildFromSource(req: BuildFromSourceRequest): Promise<SourceBuildResult> {
  const strategy = req.strategy ?? 'buildpacks';
  const runtime = (req.runtime ?? 'unknown') as DetectedRuntime;
  const image = defaultBuiltImageRef({
    appName: req.appName,
    githubRepo: req.githubRepo,
    tag: req.gitRef.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40) || 'latest',
  });

  if (strategy === 'skip') {
    return {
      success: false,
      image,
      summary: 'No Dockerfile and runtime not detected — cannot build image automatically.',
      error: 'needs_image_build',
    };
  }

  try {
    if (strategy === 'existing-dockerfile') {
      const built = await runKanikoJob({
        incidentId: req.incidentId,
        namespace: req.namespace,
        githubRepo: req.githubRepo,
        gitRef: req.gitRef,
        image,
      });
      return {
        success: true,
        image: built,
        summary: `Built image from Dockerfile via Kaniko → ${built}`,
      };
    }

    if (strategy === 'buildpacks') {
      if ((process.env['PACK_CLI_PATH'] ?? '').length > 0) {
        let tmpDir: string | null = null;
        try {
          tmpDir = await mkdtemp(join(tmpdir(), 'sre-pack-'));
          const cloned = await shallowCloneRepo(
            req.githubRepo,
            req.gitRef,
            tmpDir,
            req.incidentId
          );
          if (!cloned.ok) {
            return {
              success: false,
              image,
              summary: `Clone failed: ${cloned.error}`,
              error: 'clone_failed',
            };
          }
          await runPackLocal({ repoDir: tmpDir, image, runtime });
          return {
            success: true,
            image,
            summary: `Built image with buildpacks (local pack) → ${image}`,
          };
        } finally {
          if (tmpDir && existsSync(tmpDir)) {
            await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
          }
        }
      }

      const built = await runPackJob({
        incidentId: req.incidentId,
        namespace: req.namespace,
        githubRepo: req.githubRepo,
        gitRef: req.gitRef,
        image,
        runtime,
      });
      return {
        success: true,
        image: built,
        summary: `Built image with buildpacks (in-cluster pack job) → ${built}`,
      };
    }

    if (strategy === 's2i') {
      const built = await runOpenShiftS2I({
        incidentId: req.incidentId,
        namespace: req.namespace,
        githubRepo: req.githubRepo,
        gitRef: req.gitRef,
        image,
        runtime,
      });
      return {
        success: true,
        image: built,
        summary: `Built image with OpenShift S2I → ${built}`,
      };
    }

    return {
      success: false,
      image,
      summary: `Unsupported build strategy: ${strategy}`,
      error: 'unsupported_strategy',
    };
  } catch (err) {
    log('error', AGENT, 'Source build failed', {
      incidentId: req.incidentId,
      strategy,
      error: String(err),
    });
    return {
      success: false,
      image,
      summary: `Source build failed (${strategy}): ${String(err).slice(0, 500)}`,
      error: 'build_failed',
    };
  }
}

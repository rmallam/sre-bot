/**
 * Remove a workload installed by sre-bot (Helm release and/or Deployment).
 * Returns structured facts for commander UX-18 outcome composer.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { UndeployFound, UndeployOutcomePayload } from '../../../shared/src/command-outcome.js';
import { log } from '../../../shared/src/http.js';

const execFile = promisify(execFileCb);
const AGENT = 'gitops-agent';

export interface UndeployOpts {
  namespace: string;
  releaseName: string;
  incidentId: string;
}

export interface UndeployResult {
  ok: boolean;
  outcome: UndeployOutcomePayload;
}

interface ClusterSnapshot extends UndeployFound {}

async function run(
  cmd: string,
  args: string[],
  incidentId: string,
  ignoreNotFound = true
): Promise<{ stdout: string; stderr: string }> {
  const fullArgs = ignoreNotFound ? [...args, '--ignore-not-found'] : args;
  try {
    return await execFile(cmd, fullArgs, {
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    });
  } catch (err) {
    const msg = String(err);
    if (ignoreNotFound && /not found|NotFound/i.test(msg)) {
      return { stdout: '', stderr: msg };
    }
    throw err;
  }
}

async function kubectlResourceExists(
  kind: string,
  namespace: string,
  name: string
): Promise<boolean> {
  try {
    const { stdout } = await run(
      'kubectl',
      ['get', kind, name, '-n', namespace, '-o', 'name'],
      'exists-check',
      false
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function helmReleaseExists(namespace: string, releaseName: string): Promise<boolean> {
  try {
    const { stdout } = await run(
      'helm',
      ['list', '-n', namespace, '-q'],
      'helm-list',
      false
    );
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(releaseName);
  } catch {
    return false;
  }
}

async function countLabeledResources(namespace: string, instance: string): Promise<number> {
  try {
    const { stdout } = await run(
      'kubectl',
      [
        'get',
        'all',
        '-l',
        `app.kubernetes.io/instance=${instance}`,
        '-n',
        namespace,
        '--no-headers',
      ],
      'label-count',
      true
    );
    return stdout
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function snapshotCluster(namespace: string, releaseName: string): Promise<ClusterSnapshot> {
  const [deployment, service, helmRelease, labeledResources] = await Promise.all([
    kubectlResourceExists('deployment', namespace, releaseName),
    kubectlResourceExists('service', namespace, releaseName),
    helmReleaseExists(namespace, releaseName),
    countLabeledResources(namespace, releaseName),
  ]);
  return { deployment, service, helmRelease, labeledResources };
}

export async function undeployWorkload(opts: UndeployOpts): Promise<UndeployResult> {
  const { namespace, releaseName, incidentId } = opts;
  const before = await snapshotCluster(namespace, releaseName);

  const outcome: UndeployOutcomePayload = {
    releaseName,
    namespace,
    found: { ...before },
    actions: [],
    skipped: [],
  };

  if (!before.deployment && !before.helmRelease && before.labeledResources === 0) {
    log('info', AGENT, 'Undeploy skipped — nothing to remove', { incidentId, namespace, releaseName });
    return { ok: false, outcome };
  }

  if (before.helmRelease) {
    try {
      await run('helm', ['uninstall', releaseName, '-n', namespace], incidentId, true);
      outcome.actions.push({ type: 'helm_uninstalled' });
    } catch (err) {
      log('warn', AGENT, 'helm uninstall failed', { incidentId, error: String(err) });
      outcome.actions.push({ type: 'action_failed', detail: `Helm uninstall: ${String(err)}` });
    }
  } else {
    outcome.skipped.push({ type: 'helm', reason: 'not_present' });
  }

  const afterHelm = await snapshotCluster(namespace, releaseName);

  if (afterHelm.deployment) {
    try {
      await run(
        'kubectl',
        ['delete', 'deployment', releaseName, '-n', namespace, '--wait=false'],
        incidentId,
        true
      );
      outcome.actions.push({ type: 'deployment_deleted' });
    } catch (err) {
      outcome.actions.push({ type: 'action_failed', detail: `Deployment delete: ${String(err)}` });
    }
  } else if (before.deployment && before.helmRelease) {
    outcome.actions.push({ type: 'deployment_removed_by_helm' });
  } else if (!before.deployment) {
    outcome.skipped.push({ type: 'deployment', reason: 'not_present' });
  }

  if (before.service) {
    try {
      await run(
        'kubectl',
        ['delete', 'service', releaseName, '-n', namespace, '--wait=false'],
        incidentId,
        true
      );
      outcome.actions.push({ type: 'service_deleted' });
    } catch (err) {
      outcome.actions.push({ type: 'action_failed', detail: `Service delete: ${String(err)}` });
    }
  } else {
    outcome.skipped.push({ type: 'service', reason: 'not_present' });
  }

  if (before.labeledResources > 0) {
    try {
      const del = await run(
        'kubectl',
        [
          'delete',
          'all',
          '-l',
          `app.kubernetes.io/instance=${releaseName}`,
          '-n',
          namespace,
          '--wait=false',
        ],
        incidentId,
        true
      );
      if (del.stdout.trim() && !(before.helmRelease || before.deployment)) {
        outcome.actions.push({
          type: 'labeled_resources_deleted',
          count: before.labeledResources,
        });
      } else if (del.stdout.trim()) {
        outcome.skipped.push({ type: 'labeled', reason: 'already_removed' });
      } else if (!before.helmRelease && !before.deployment) {
        outcome.actions.push({
          type: 'labeled_resources_deleted',
          count: before.labeledResources,
        });
      }
    } catch (err) {
      outcome.actions.push({ type: 'action_failed', detail: `Label cleanup: ${String(err)}` });
    }
  }

  const stillExists = await kubectlResourceExists('deployment', namespace, releaseName);
  if (stillExists) {
    outcome.incomplete = true;
    log('warn', AGENT, 'Undeploy incomplete', { incidentId, namespace, releaseName });
    return { ok: false, outcome };
  }

  log('info', AGENT, 'Undeploy complete', { incidentId, namespace, releaseName, actions: outcome.actions.length });
  return { ok: true, outcome };
}

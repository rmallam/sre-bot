/**
 * Remove a workload installed by sre-bot (Helm release and/or Deployment).
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
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
  message: string;
  steps: string[];
}

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

export async function undeployWorkload(opts: UndeployOpts): Promise<UndeployResult> {
  const { namespace, releaseName, incidentId } = opts;
  const steps: string[] = [];

  try {
    const helm = await run(
      'helm',
      ['uninstall', releaseName, '-n', namespace],
      incidentId,
      true
    );
    if (helm.stdout.trim()) steps.push(`Helm: ${helm.stdout.trim()}`);
    else steps.push(`Helm: release \`${releaseName}\` not found (skipped).`);
  } catch (err) {
    log('warn', AGENT, 'helm uninstall failed', { incidentId, error: String(err) });
    steps.push(`Helm uninstall warning: ${String(err)}`);
  }

  for (const kind of ['deployment', 'service'] as const) {
    try {
      await run(
        'kubectl',
        ['delete', kind, releaseName, '-n', namespace, '--wait=false'],
        incidentId,
        true
      );
      steps.push(`Deleted ${kind} \`${releaseName}\` in \`${namespace}\` (if it existed).`);
    } catch (err) {
      steps.push(`Could not delete ${kind}: ${String(err)}`);
    }
  }

  try {
    await run(
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
    steps.push(`Cleaned up resources labeled app.kubernetes.io/instance=${releaseName}.`);
  } catch {
    /* optional */
  }

  const message =
    `Removed \`${releaseName}\` from namespace \`${namespace}\`.\n` +
    steps.map((s) => `• ${s}`).join('\n') +
    `\n\nCheck: \`kubectl get pods -n ${namespace}\``;

  log('info', AGENT, 'Undeploy complete', { incidentId, namespace, releaseName });
  return { ok: true, message, steps };
}

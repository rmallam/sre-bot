/**
 * Create namespace when user approved (createNamespace) or chart deploy requires it.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DeployNotifyTarget } from '../../../shared/src/deploy-notify.js';
import { sendDeployProgress } from '../../../shared/src/deploy-notify.js';
import { log } from '../../../shared/src/http.js';

const execFile = promisify(execFileCb);

export async function ensureNamespace(opts: {
  namespace: string;
  incidentId: string;
  notify?: DeployNotifyTarget;
}): Promise<void> {
  const { namespace, incidentId, notify } = opts;

  await sendDeployProgress(
    notify,
    `Creating namespace \`${namespace}\` in the cluster…`
  );

  const manifest = `apiVersion: v1
kind: Namespace
metadata:
  name: ${namespace}
  labels:
    app.kubernetes.io/managed-by: sre-bot
`;

  const tmp = await mkdtemp(join(tmpdir(), 'sre-ns-'));
  const manifestPath = join(tmp, 'namespace.yaml');
  await writeFile(manifestPath, manifest, 'utf-8');

  try {
    await execFile('kubectl', ['apply', '-f', manifestPath], {
      timeout: 60_000,
      env: process.env,
    });
    log('info', 'gitops-agent', 'Namespace ensured', { incidentId, namespace });
    await sendDeployProgress(notify, `Namespace \`${namespace}\` is ready.`);
  } catch (err) {
    const msg = String(err);
    if (/already exists/i.test(msg)) {
      await sendDeployProgress(notify, `Namespace \`${namespace}\` already exists — continuing.`);
      return;
    }
    throw new Error(`Could not create namespace ${namespace}: ${msg.slice(0, 400)}`);
  }
}

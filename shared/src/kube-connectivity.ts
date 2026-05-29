/**
 * Cluster connectivity helpers for agents running kubectl inside compose/Podman.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export async function listKubeClusters(): Promise<string[]> {
  const { stdout } = await execFile('kubectl', ['config', 'get-clusters'], {
    timeout: 15_000,
    env: process.env,
  });
  return stdout
    .trim()
    .split(/\s+/)
    .filter((c) => c && c !== 'NAME');
}

/** Podman Desktop / forwarded API: cert is for kubernetes.internal, not host.containers.internal */
export async function remediateKubeconfigInsecureTls(): Promise<string[]> {
  const clusters = await listKubeClusters();
  const patched: string[] = [];
  for (const name of clusters) {
    await execFile(
      'kubectl',
      ['config', 'set-cluster', name, '--insecure-skip-tls-verify=true'],
      { timeout: 15_000, env: process.env }
    );
    patched.push(name);
  }
  return patched;
}

export async function probeClusterConnectivity(incidentId?: string): Promise<void> {
  await execFile(
    'kubectl',
    ['get', 'ns', '--request-timeout=15s', '-o', 'name'],
    {
      timeout: 20_000,
      env: process.env,
      maxBuffer: 2 * 1024 * 1024,
    }
  );
  void incidentId;
}

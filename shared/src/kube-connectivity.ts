/**
 * Cluster connectivity helpers for agents running kubectl inside compose/Podman or in-cluster.
 */

import { execFile as execFileCb } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export function isInClusterKube(): boolean {
  return existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token');
}

export async function listKubeClusters(): Promise<string[]> {
  if (isInClusterKube()) return [];
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
  if (isInClusterKube()) {
    return [];
  }
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
  // Do not pass --request-timeout to kubectl in-cluster: it breaks against newer
  // API servers (memcache "could not find the requested resource"). execFile timeout is enough.
  await execFile(
    'kubectl',
    ['get', 'ns', '-o', 'name'],
    {
      timeout: 20_000,
      env: process.env,
      maxBuffer: 2 * 1024 * 1024,
    }
  );
  void incidentId;
}

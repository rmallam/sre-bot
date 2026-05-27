/**
 * Argo CD / Rollouts helpers exposed as HTTP tools for the orchestrator runtime.
 */

import { log } from '../../../shared/src/http.js';
import { waitForSync } from './argocd.js';

const AGENT = 'gitops-argo-tools';

export async function handleArgoWaitSync(body: {
  appName: string;
  timeoutMs?: number;
  incidentId?: string;
}): Promise<{ synced: boolean; status: string }> {
  const timeoutMs = body.timeoutMs ?? parseInt(process.env['ARGOCD_SYNC_TIMEOUT_MS'] ?? '300000', 10);
  const status = await waitForSync(body.appName, timeoutMs);
  log('info', AGENT, 'argo.wait_sync completed', {
    incidentId: body.incidentId,
    appName: body.appName,
    status,
  });
  return { synced: status === 'Synced', status };
}

/**
 * Promote canary — requires kubectl + argo-rollouts CRD in cluster.
 * Returns success=false when rollout controller is unavailable.
 */
export async function handleArgoRolloutPromote(body: {
  namespace: string;
  rolloutName: string;
  incidentId?: string;
}): Promise<{ success: boolean; error?: string; summary?: string }> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  try {
    await execFileAsync(
      'kubectl',
      [
        'argo',
        'rollouts',
        'promote',
        body.rolloutName,
        '-n',
        body.namespace,
      ],
      { timeout: 60_000 }
    );
    log('info', AGENT, 'argo.rollout_promote succeeded', {
      incidentId: body.incidentId,
      rollout: body.rolloutName,
      namespace: body.namespace,
    });
    return { success: true, summary: 'rollout promoted' };
  } catch (err) {
    const msg = String(err);
    log('warn', AGENT, 'argo.rollout_promote failed', {
      incidentId: body.incidentId,
      error: msg,
    });
    return {
      success: false,
      error: msg.includes('executable file not found')
        ? 'kubectl not available in gitops-agent'
        : msg,
    };
  }
}

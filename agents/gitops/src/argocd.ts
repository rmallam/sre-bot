/**
 * argocd.ts — ArgoCD sync status poller.
 *
 * Polls the ArgoCD API until the target app reaches Synced status or the
 * timeout elapses. If ARGOCD_URL is not configured, returns 'Unknown'
 * immediately so callers can degrade gracefully.
 */

import { log } from '../../../shared/src/http.js';

const AGENT = 'gitops-agent';
const POLL_INTERVAL_MS = 10_000;

export type SyncStatus = 'Synced' | 'Degraded' | 'Timeout' | 'Unknown';

/**
 * ArgoCDApplication represents the subset of the ArgoCD REST response
 * that we care about.
 */
interface ArgoCDApp {
  status?: {
    sync?: {
      status?: string;
    };
    health?: {
      status?: string;
    };
    operationState?: {
      phase?: string;
    };
  };
}

/**
 * waitForSync — polls ArgoCD until the app syncs, degrades, or the timeout fires.
 *
 * @param appName   - ArgoCD application name
 * @param timeoutMs - Maximum milliseconds to wait
 */
export async function waitForSync(
  appName: string,
  timeoutMs: number,
): Promise<SyncStatus> {
  const argocdUrl = process.env['ARGOCD_URL'];
  const argocdToken = process.env['ARGOCD_TOKEN'];

  if (!argocdUrl) {
    log('warn', AGENT, 'ARGOCD_URL not configured — skipping sync poll', { appName });
    return 'Unknown';
  }

  const apiUrl = `${argocdUrl.replace(/\/$/, '')}/api/v1/applications/${encodeURIComponent(appName)}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (argocdToken) {
    headers['Authorization'] = `Bearer ${argocdToken}`;
  }

  const deadline = Date.now() + timeoutMs;
  let pollCount = 0;

  log('info', AGENT, 'Starting ArgoCD sync poll', {
    appName,
    apiUrl,
    timeoutMs,
  });

  while (Date.now() < deadline) {
    pollCount++;
    try {
      const res = await fetch(apiUrl, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        log('warn', AGENT, `ArgoCD API non-2xx (poll ${pollCount})`, {
          appName,
          status: res.status,
          body,
        });
      } else {
        const data = (await res.json()) as ArgoCDApp;
        const syncStatus = data?.status?.sync?.status ?? '';
        const healthStatus = data?.status?.health?.status ?? '';

        log('info', AGENT, `ArgoCD poll ${pollCount}`, {
          appName,
          syncStatus,
          healthStatus,
        });

        if (syncStatus === 'Synced') {
          log('info', AGENT, 'ArgoCD app synced successfully', { appName, pollCount });
          return 'Synced';
        }

        if (healthStatus === 'Degraded') {
          log('error', AGENT, 'ArgoCD app health is Degraded', { appName, pollCount });
          return 'Degraded';
        }
      }
    } catch (err: unknown) {
      log('warn', AGENT, `ArgoCD poll error (poll ${pollCount})`, {
        appName,
        error: String(err),
      });
    }

    // Wait for the next poll interval, but bail early if deadline has passed
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
  }

  log('warn', AGENT, 'ArgoCD sync poll timed out', { appName, pollCount, timeoutMs });
  return 'Timeout';
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

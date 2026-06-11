/**
 * Cancel orchestrator run (deploy source prompt dismissed).
 */

import { agentFetch } from './agent-fetch.js';

const ORCHESTRATOR_URL = process.env['ORCHESTRATOR_URL'] ?? 'http://orchestrator-agent:8080';

export async function cancelRun(runId: string): Promise<boolean> {
  const res = await agentFetch(`${ORCHESTRATOR_URL}/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'deploy_source_cancelled' }),
    signal: AbortSignal.timeout(10_000),
  });
  return res.ok;
}

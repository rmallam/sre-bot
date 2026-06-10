/**
 * Post-apply workload discovery (Layer 4) via investigator.
 */

import type { DeployReleaseTargets } from '../../../shared/src/deploy-workloads.js';

const INVESTIGATOR_URL = process.env['INVESTIGATOR_URL'] ?? 'http://investigator-agent:8080';

export async function captureDeployReleaseTargets(opts: {
  namespace: string;
  releaseName: string;
  incidentId: string;
}): Promise<DeployReleaseTargets | undefined> {
  const params = new URLSearchParams({
    namespace: opts.namespace,
    releaseName: opts.releaseName,
    incidentId: opts.incidentId,
  });
  try {
    const res = await fetch(`${INVESTIGATOR_URL}/discover-workloads?${params}`, {
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as DeployReleaseTargets;
    if (!body.workloads?.length) return undefined;
    return body;
  } catch {
    return undefined;
  }
}

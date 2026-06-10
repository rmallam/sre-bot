/**
 * Persist Layer 4 deploy workload targets into run metadata.
 */

import {
  mergeDeployReleaseTargets,
  parseDeployReleaseTargets,
  type DeployReleaseTargets,
} from '../../../shared/src/deploy-workloads.js';
import { catalogUpsertFromDeploy } from '../../../shared/src/app-discovery.js';
import { log } from '../../../shared/src/http.js';
import { getRun, mergeRunMetadata } from './run-store.js';

const INVESTIGATOR_URL = process.env.INVESTIGATOR_URL ?? 'http://investigator-agent:8080';

async function proposeAppCatalogFromDeploy(targets: DeployReleaseTargets): Promise<void> {
  if (!targets.workloads?.length) return;
  try {
    const res = await fetch(`${INVESTIGATOR_URL}/apps/catalog/upsert-auto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(catalogUpsertFromDeploy({
        releaseName: targets.releaseName,
        namespace: targets.namespace,
        members: targets.workloads.map((w) => ({
          resourceKind: w.resourceKind,
          resourceName: w.resourceName,
        })),
      })),
    });
    if (!res.ok) {
      log('warn', 'orchestrator', 'Auto catalog upsert failed', {
        status: res.status,
        release: targets.releaseName,
      });
    }
  } catch (err) {
    log('warn', 'orchestrator', 'Auto catalog upsert failed', { error: String(err) });
  }
}

export async function persistDeployReleaseTargets(
  runId: string | undefined,
  targets: DeployReleaseTargets | undefined
): Promise<void> {
  if (!runId || !targets?.workloads?.length) return;
  const run = await getRun(runId);
  const existing = parseDeployReleaseTargets(run?.metadata);
  await mergeRunMetadata(runId, {
    deployReleaseTargets: mergeDeployReleaseTargets(existing, targets),
  });
  await proposeAppCatalogFromDeploy(targets);
}

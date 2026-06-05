/**
 * Pause diagnose runs when deploy source (repo/chart/argo) is unknown.
 */

import type { DiagnosisContext, RunStatus, StartRunRequest } from '../../../shared/src/types.js';
import {
  buildDeploySourcePrompt,
  isDeploySourceReady,
  mergeDeployProvenance,
  needsDeploySourcePrompt,
  type DeployProvenance,
} from '../../../shared/src/deploy-provenance.js';
import { saveDeploySourceRegistry } from '../../../shared/src/deploy-source-registry.js';
import { applyDeploySourceHints, parseDeploySourceReply, type DeploySourceParseResult } from '../../../shared/src/deploy-source-parse.js';

export interface DeploySourceGateInput {
  mode: StartRunRequest['mode'];
  namespace: string;
  resourceKind: StartRunRequest['resourceKind'];
  resourceName: string;
  request: StartRunRequest;
  facts?: DiagnosisContext;
}

export interface DeploySourceGateResult {
  blocked: boolean;
  prompt?: string;
  provenance?: DeployProvenance;
  enrichedFacts?: import('../../../shared/src/types.js').SanitizedFacts;
}

export function mergeRequestProvenance(
  request: StartRunRequest,
  facts?: DiagnosisContext
): DeployProvenance {
  const fromRequest = request.deployProvenance as Partial<DeployProvenance> | undefined;
  const parsedFromHints = parseHintsFromUser(request.userHints);
  return mergeDeployProvenance(
    facts?.deployProvenance,
    fromRequest,
    parsedFromHints,
    request.allowClusterHotFix ? { allowClusterHotFix: true } : undefined
  );
}

function parseHintsFromUser(hints?: string[]): Partial<DeployProvenance> | undefined {
  if (!hints?.length) return undefined;
  const result = parseDeploySourceReply(hints.join(' '));
  return result.provenance;
}

export async function evaluateDeploySourceGate(
  input: DeploySourceGateInput
): Promise<DeploySourceGateResult> {
  if (input.mode !== 'diagnose') {
    return { blocked: false, provenance: input.facts?.deployProvenance };
  }

  let provenance = mergeRequestProvenance(input.request, input.facts);

  if (isDeploySourceReady(provenance)) {
    if (provenance.source === 'user-provided' || input.request.deployProvenance) {
      await saveDeploySourceRegistry(
        input.namespace,
        input.resourceKind,
        input.resourceName,
        provenance,
        input.request.caseId
      ).catch(() => undefined);
    }
    const enrichedFacts = input.facts
      ? { ...input.facts, deployProvenance: provenance }
      : undefined;
    return { blocked: false, provenance, enrichedFacts };
  }

  if (!needsDeploySourcePrompt(provenance, input.mode)) {
    return { blocked: false, provenance };
  }

  const prompt = buildDeploySourcePrompt(
    input.namespace,
    input.resourceKind,
    input.resourceName,
    provenance
  );

  return {
    blocked: true,
    prompt,
    provenance,
    enrichedFacts: input.facts ? { ...input.facts, deployProvenance: provenance } : undefined,
  };
}

export async function persistUserDeploySource(
  namespace: string,
  resourceKind: StartRunRequest['resourceKind'],
  resourceName: string,
  parsed: DeploySourceParseResult,
  base?: DeployProvenance,
  runId?: string
): Promise<DeployProvenance> {
  const merged = applyDeploySourceHints(base, parsed);
  if (isDeploySourceReady(merged) && !parsed.cancelled && parsed.provenance) {
    await saveDeploySourceRegistry(namespace, resourceKind, resourceName, merged, runId);
  }
  return merged;
}

/** LangGraph node — pause when Git/Helm deploy source is incomplete. */
export async function provenanceGateNode(state: {
  runId: string;
  incidentId: string;
  mode: StartRunRequest['mode'];
  namespace: string;
  resourceName: string;
  resourceKind: StartRunRequest['resourceKind'];
  request: StartRunRequest;
  factsSanitized?: DiagnosisContext;
  status: RunStatus;
}): Promise<{
  status?: RunStatus;
  lastError?: string;
  awaitingHuman?: boolean;
  factsSanitized?: DiagnosisContext;
}> {
  if (state.mode !== 'diagnose' || state.status === 'failed' || state.status === 'escalated') {
    return {};
  }

  const gate = await evaluateDeploySourceGate({
    mode: state.mode,
    namespace: state.namespace,
    resourceKind: state.resourceKind,
    resourceName: state.resourceName,
    request: state.request,
    facts: state.factsSanitized,
  });

  if (!gate.blocked || !gate.prompt) {
    if (gate.enrichedFacts && state.factsSanitized) {
      return { factsSanitized: gate.enrichedFacts as DiagnosisContext };
    }
    return {};
  }

  const { notifyUserUpdate } = await import('./tools.js');
  const { mergeRunMetadata } = await import('./run-store.js');

  await mergeRunMetadata(state.runId, {
    deploySourcePending: {
      provenance: gate.provenance,
      missingFields: gate.provenance?.missingFields ?? [],
      prompt: gate.prompt,
    },
  });

  if (state.request.platform && state.request.channelId) {
    await notifyUserUpdate(
      {
        runId: state.runId,
        incidentId: state.incidentId,
        request: state.request,
        namespace: state.namespace,
        resourceName: state.resourceName,
        resourceKind: state.resourceKind,
        mode: state.mode,
      },
      {
        kind: 'deploy_source_required',
        incidentId: state.incidentId,
        runId: state.runId,
        namespace: state.namespace,
        resourceName: state.resourceName,
        technicalMessage: gate.prompt,
      }
    );
  }

  return {
    status: 'awaiting_human',
    awaitingHuman: true,
    lastError: 'deploy_source_missing',
    factsSanitized: gate.enrichedFacts as DiagnosisContext | undefined,
  };
}

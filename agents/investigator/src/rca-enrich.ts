/**
 * Deep RCA enrichment — parallel observability pointers via plugin registry (PLAT-14).
 */

import type { DiagnosisContext, SpecialistDiagnostic } from '../../../shared/src/types.js';
import type { RcaInvestigateScope } from '../../../shared/src/rca/plugin.js';
import { gatherAllRcaPointers } from '../../../shared/src/rca/registry.js';
import {
  createDefaultRcaPlugins,
  specialistPluginsFrom,
} from '../../../shared/src/rca/plugins.js';

export interface DeepRcaInput {
  incidentId: string;
  namespace: string;
  resourceName: string;
  podName: string;
  scope?: RcaInvestigateScope;
  k8sFacts: Partial<DiagnosisContext>;
  specialistDiagnostics?: SpecialistDiagnostic[];
}

export type DeepRcaResult = Awaited<ReturnType<typeof gatherAllRcaPointers>>;

export async function enrichWithDeepRca(input: DeepRcaInput): Promise<DeepRcaResult> {
  const scope = input.scope ?? 'workload';
  const specialists = input.specialistDiagnostics ?? [];
  const plugins = [
    ...specialistPluginsFrom(specialists),
    ...createDefaultRcaPlugins().filter((p) => !p.id.startsWith('specialist')),
  ];

  return gatherAllRcaPointers(
    {
      incidentId: input.incidentId,
      namespace: input.namespace,
      resourceName: input.resourceName,
      podName: input.podName,
      scope,
      k8sFacts: input.k8sFacts,
      specialistDiagnostics: specialists,
    },
    plugins
  );
}

export async function enrichScopeWithDeepRca(input: {
  incidentId: string;
  scope: 'cluster' | 'namespace';
  namespace: string;
  resourceName: string;
  podName: string;
  k8sFacts: Partial<DiagnosisContext>;
}): Promise<DeepRcaResult> {
  return enrichWithDeepRca({
    ...input,
    scope: input.scope,
    specialistDiagnostics: [],
  });
}

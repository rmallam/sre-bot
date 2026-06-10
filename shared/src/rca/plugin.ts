/**
 * RCA plugin SDK — datasource interface for deep RCA (PLAT-14).
 */

import type { DiagnosisContext, SpecialistDiagnostic } from '../types.js';
import type { RcaPointer } from '../rca-pointers.js';

export type RcaInvestigateScope = 'cluster' | 'namespace' | 'workload';

export interface ScopeHealthSummary {
  scope: 'cluster' | 'namespace';
  nodeCount?: number;
  notReadyNodeCount?: number;
  unhealthyDeployments: Array<{ namespace: string; name: string; ready: number; desired: number }>;
}

export interface RcaGatherContext {
  incidentId: string;
  namespace: string;
  resourceName: string;
  podName: string;
  scope: RcaInvestigateScope;
  k8sFacts: Partial<DiagnosisContext>;
  specialistDiagnostics?: SpecialistDiagnostic[];
}

export interface RcaPluginResult {
  pointer: RcaPointer;
  supplementalLogLines?: string[];
}

export interface RcaPlugin {
  id: string;
  isConfigured(): boolean;
  /** Skip when scope or facts do not match this plugin. */
  isApplicable(ctx: RcaGatherContext): boolean;
  gather(ctx: RcaGatherContext): Promise<RcaPluginResult | null>;
}

export interface DeepRcaResult {
  rcaPointers: RcaPointer[];
  observabilitySummary: string;
  enrichedCurrentLogs: string;
  enrichedPreviousLogs: string;
}

/**
 * Canonical tool catalog — schemas, risk metadata, and policy hints.
 */

import type { ToolCall, ToolCallName } from './tool-contracts.js';
import type { IncidentMode } from './types.js';

export type ToolRiskLevel = 'low' | 'medium' | 'high';

export interface ToolDefinition {
  name: ToolCallName;
  description: string;
  risk: ToolRiskLevel;
  /** When true, autonomy policy should require HIL in production namespaces. */
  requiresHilInProd: boolean;
  supportsDryRun: boolean;
  idempotent: boolean;
  maxRetries: number;
  /** Dot-paths that must be present on tool input (shallow check). */
  requiredFields: string[];
  allowedModes?: IncidentMode[];
}

export const TOOL_REGISTRY: Record<ToolCallName, ToolDefinition> = {
  'investigator.repo_inspect': {
    name: 'investigator.repo_inspect',
    description: 'Clone and inspect repository for deploy entry points (read-only)',
    risk: 'low',
    requiresHilInProd: false,
    supportsDryRun: false,
    idempotent: true,
    maxRetries: 2,
    requiredFields: ['incidentId', 'githubRepo', 'namespace', 'resourceName'],
    allowedModes: ['pre-deploy'],
  },
  'executor.restart_workload': {
    name: 'executor.restart_workload',
    description: 'Rollout restart via restartedAt annotation',
    risk: 'low',
    requiresHilInProd: false,
    supportsDryRun: false,
    idempotent: true,
    maxRetries: 2,
    requiredFields: ['incidentId', 'namespace', 'resourceName', 'resourceKind'],
    allowedModes: ['diagnose', 'rollback'],
  },
  'gitops.apply_plan': {
    name: 'gitops.apply_plan',
    description: 'Apply remediation plan via GitOps or direct repo apply',
    risk: 'high',
    requiresHilInProd: true,
    supportsDryRun: true,
    idempotent: false,
    maxRetries: 1,
    requiredFields: ['incidentId', 'namespace', 'resourceName', 'plan'],
    allowedModes: ['diagnose', 'pre-deploy', 'rollback'],
  },
  'investigator.verify_health': {
    name: 'investigator.verify_health',
    description: 'Check workload readiness after remediation',
    risk: 'low',
    requiresHilInProd: false,
    supportsDryRun: false,
    idempotent: true,
    maxRetries: 3,
    requiredFields: ['incidentId', 'namespace', 'resourceName'],
  },
  'commander.notify': {
    name: 'commander.notify',
    description: 'Send user notification on Slack/Telegram',
    risk: 'low',
    requiresHilInProd: false,
    supportsDryRun: false,
    idempotent: true,
    maxRetries: 2,
    requiredFields: ['incidentId', 'message'],
  },
  'argo.wait_sync': {
    name: 'argo.wait_sync',
    description: 'Poll Argo CD until application is Synced or timeout',
    risk: 'low',
    requiresHilInProd: false,
    supportsDryRun: false,
    idempotent: true,
    maxRetries: 1,
    requiredFields: ['incidentId', 'appName'],
    allowedModes: ['diagnose', 'pre-deploy', 'rollback'],
  },
  'argo.rollout_promote': {
    name: 'argo.rollout_promote',
    description: 'Promote Argo Rollouts canary to stable (full traffic)',
    risk: 'high',
    requiresHilInProd: true,
    supportsDryRun: false,
    idempotent: false,
    maxRetries: 1,
    requiredFields: ['incidentId', 'namespace', 'rolloutName'],
    allowedModes: ['diagnose', 'rollback'],
  },
};

export function getToolDefinition(name: ToolCallName): ToolDefinition {
  return TOOL_REGISTRY[name];
}

export function listToolDefinitions(): ToolDefinition[] {
  return Object.values(TOOL_REGISTRY);
}

/** Output of compile + validate before execution. */
export interface CompiledPlan {
  calls: ToolCall[];
  confidence: number;
  riskLevel: ToolRiskLevel;
  validation: { ok: boolean; errors: string[] };
  fallbackReason?: string;
}

export function aggregateToolRisk(calls: { name: ToolCallName }[]): ToolRiskLevel {
  let level: ToolRiskLevel = 'low';
  for (const call of calls) {
    const def = TOOL_REGISTRY[call.name];
    if (def.risk === 'high') return 'high';
    if (def.risk === 'medium') level = 'medium';
  }
  return level;
}

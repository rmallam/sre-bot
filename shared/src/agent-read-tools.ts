/**
 * Read-only tools for agentic investigate loop.
 */

export type AgentReadToolName =
  | 'investigator.get_workload'
  | 'investigator.get_events'
  | 'investigator.get_cluster_health'
  | 'investigator.get_namespace_health'
  | 'investigator.logs_query'
  | 'investigator.metrics_query';

export interface AgentReadToolCall {
  name: AgentReadToolName;
  input?: Record<string, unknown>;
}

export interface AgentStepRecord {
  tool: AgentReadToolName;
  summary: string;
  at: string;
}

export const AGENT_READ_TOOL_NAMES: AgentReadToolName[] = [
  'investigator.get_workload',
  'investigator.get_events',
  'investigator.get_cluster_health',
  'investigator.get_namespace_health',
  'investigator.logs_query',
  'investigator.metrics_query',
];

export function isAgentReadTool(name: string): name is AgentReadToolName {
  return (AGENT_READ_TOOL_NAMES as string[]).includes(name);
}

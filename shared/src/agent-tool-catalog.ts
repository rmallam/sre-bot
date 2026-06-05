/**
 * Read-tool catalog for LLM agentic investigation (ReAct loop).
 */

import type { AgentReadToolName } from './agent-read-tools.js';

export interface AgentReadToolSpec {
  name: AgentReadToolName;
  description: string;
  whenToUse: string;
}

export const AGENT_READ_TOOL_CATALOG: AgentReadToolSpec[] = [
  {
    name: 'investigator.get_workload',
    description: 'Deployment/StatefulSet status, container states, image, restarts',
    whenToUse: 'First step or when workload health is unknown',
  },
  {
    name: 'investigator.get_events',
    description: 'Recent Kubernetes Warning/Normal events for the workload',
    whenToUse: 'After workload check; ImagePullBackOff, CrashLoop, probe failures',
  },
  {
    name: 'investigator.logs_query',
    description: 'Container log excerpt (Loki or pod logs)',
    whenToUse: 'CrashLoopBackOff, probe failures, application errors',
  },
  {
    name: 'investigator.metrics_query',
    description: 'Prometheus CPU/memory/restart metrics for deployment',
    whenToUse: 'OOM suspects, performance degradation, restart spikes',
  },
  {
    name: 'investigator.get_namespace_health',
    description: 'Namespace-wide deployment readiness summary',
    whenToUse: 'Multiple workloads affected or namespace-scoped issue',
  },
  {
    name: 'investigator.get_cluster_health',
    description: 'Cluster-wide node and deployment health overview',
    whenToUse: 'Cluster-wide or control-plane symptoms',
  },
];

export function formatAgentToolCatalogForLlm(): string {
  return AGENT_READ_TOOL_CATALOG.map(
    (t) => `- ${t.name}: ${t.description}. Use when: ${t.whenToUse}`
  ).join('\n');
}

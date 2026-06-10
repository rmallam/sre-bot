/**
 * Read-only debug tool catalog — human power-user only (PLAT-11).
 * Not wired to brain, orchestrator, or autonomous agent loops.
 */

import {
  getPodLogs,
  listDeployments,
  listEvents,
  listPods,
  queryLogs,
  queryMetrics,
} from './k8s-read.js';

export interface DebugToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

export const DEBUG_TOOLS: DebugToolDef[] = [
  {
    name: 'k8s_list_pods',
    description: 'List pods (read-only). Optional namespace filter.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Kubernetes namespace (omit for all)' },
      },
    },
  },
  {
    name: 'k8s_list_events',
    description: 'List recent Warning events (read-only).',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Kubernetes namespace (omit for all)' },
      },
    },
  },
  {
    name: 'k8s_list_deployments',
    description: 'List deployments with ready/desired counts (read-only).',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Kubernetes namespace (omit for all)' },
      },
    },
  },
  {
    name: 'k8s_get_pod_logs',
    description: 'Fetch pod logs (read-only, tail capped).',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string' },
        pod: { type: 'string' },
        container: { type: 'string' },
        tailLines: { type: 'number' },
      },
      required: ['namespace', 'pod'],
    },
  },
  {
    name: 'observability_query_logs',
    description: 'Query Loki logs via allowlisted investigator queries (read-only).',
    inputSchema: {
      type: 'object',
      properties: {
        incidentId: { type: 'string' },
        namespace: { type: 'string' },
        pod: { type: 'string' },
        deployment: { type: 'string' },
        sinceMinutes: { type: 'number' },
      },
      required: ['incidentId'],
    },
  },
  {
    name: 'observability_query_metrics',
    description: 'Query Prometheus via allowlisted kube-state-metrics queries (read-only).',
    inputSchema: {
      type: 'object',
      properties: {
        incidentId: { type: 'string' },
        namespace: { type: 'string' },
        deployment: { type: 'string' },
        pod: { type: 'string' },
      },
      required: ['incidentId', 'namespace'],
    },
  },
];

export async function callDebugTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  let result: object;
  switch (name) {
    case 'k8s_list_pods':
      result = await listPods(args['namespace'] as string | undefined);
      break;
    case 'k8s_list_events':
      result = await listEvents(args['namespace'] as string | undefined);
      break;
    case 'k8s_list_deployments':
      result = await listDeployments(args['namespace'] as string | undefined);
      break;
    case 'k8s_get_pod_logs':
      result = await getPodLogs({
        namespace: String(args['namespace'] ?? ''),
        pod: String(args['pod'] ?? ''),
        container: args['container'] as string | undefined,
        tailLines: args['tailLines'] as number | undefined,
      });
      break;
    case 'observability_query_logs':
      result = await queryLogs({
        incidentId: String(args['incidentId'] ?? 'debug'),
        namespace: args['namespace'] as string | undefined,
        pod: args['pod'] as string | undefined,
        deployment: args['deployment'] as string | undefined,
        sinceMinutes: args['sinceMinutes'] as number | undefined,
      });
      break;
    case 'observability_query_metrics':
      result = await queryMetrics({
        incidentId: String(args['incidentId'] ?? 'debug'),
        namespace: String(args['namespace'] ?? ''),
        deployment: args['deployment'] as string | undefined,
        pod: args['pod'] as string | undefined,
      });
      break;
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

export function mcpToolList(): Array<{
  name: string;
  description: string;
  inputSchema: DebugToolDef['inputSchema'];
}> {
  return DEBUG_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

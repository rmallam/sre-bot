/**
 * AGENT-3 — Execute read-only investigator tools for agentic observe loop.
 */

import type { DiagnosisContext } from '../../../shared/src/types.js';
import type { AgentReadToolCall, AgentReadToolName } from '../../../shared/src/agent-read-tools.js';
import {
  extractPrimaryFailure,
  enrichFactsWithPrimaryFailure,
  formatPrimaryFailureMessage,
} from '../../../shared/src/investigation-diagnosis.js';
import { gatherWorkloadPodFacts, resolveWorkloadGatherTarget } from './workload-gather.js';
import {
  gatherClusterHealthFacts,
  gatherNamespaceHealthFacts,
} from './cluster-facts.js';
import { queryLogs, queryMetrics } from './observability.js';
import { gatherFactsSync } from './facts-sync.js';

export type { AgentReadToolCall, AgentReadToolName } from '../../../shared/src/agent-read-tools.js';
export { AGENT_READ_TOOL_NAMES } from '../../../shared/src/agent-read-tools.js';

export interface AgentStepRequest {
  incidentId: string;
  runId?: string;
  caseId?: string;
  namespace: string;
  resourceName: string;
  resourceKind?: import('../../../shared/src/types.js').ResourceKind;
  toolCall: AgentReadToolCall;
}

export interface AgentStepResult {
  tool: AgentReadToolName;
  summary: string;
  data: Partial<DiagnosisContext> | Record<string, unknown>;
  primaryFinding?: string;
}

function summarizeWorkload(facts: Partial<DiagnosisContext>, ns: string, name: string): string {
  const primary = extractPrimaryFailure(facts);
  if (primary) {
    return `Workload ${ns}/${name}: ${primary.summary}`;
  }
  const waiting = (facts.containerStatuses ?? []).find((s) => {
    const st = s as { state?: { waiting?: { reason?: string } } };
    return st.state?.waiting?.reason;
  }) as { state?: { waiting?: { reason?: string } } } | undefined;
  const reason = waiting?.state?.waiting?.reason ?? 'Running';
  return `Workload ${ns}/${name}: container state ${reason}`;
}

export async function executeAgentReadTool(req: AgentStepRequest): Promise<AgentStepResult> {
  const { toolCall, namespace, resourceName, resourceKind, incidentId } = req;
  const kind = resourceKind ?? 'Deployment';

  switch (toolCall.name) {
    case 'investigator.get_workload': {
      const facts = enrichFactsWithPrimaryFailure(
        await gatherWorkloadPodFacts(namespace, resourceName, kind, incidentId)
      );
      const primary = extractPrimaryFailure(facts);
      return {
        tool: toolCall.name,
        summary: summarizeWorkload(facts, namespace, resourceName),
        data: facts,
        primaryFinding: primary ? formatPrimaryFailureMessage(primary) : undefined,
      };
    }
    case 'investigator.get_events': {
      const facts = enrichFactsWithPrimaryFailure(
        await gatherWorkloadPodFacts(namespace, resourceName, kind, incidentId)
      );
      const events = facts.recentEvents ?? [];
      const primary = extractPrimaryFailure(facts);
      const top = events.slice(0, 8).map((e) => `${e.reason}: ${e.message.slice(0, 120)}`);
      const summary = primary
        ? `${primary.summary} — ${events.length} event(s)`
        : `Found ${events.length} recent event(s)${top[0] ? ` — latest: ${top[0]}` : ''}`;
      return {
        tool: toolCall.name,
        summary,
        data: { ...facts, recentEvents: events, incidentId, namespace, resourceName },
        primaryFinding: primary ? formatPrimaryFailureMessage(primary) : undefined,
      };
    }
    case 'investigator.get_cluster_health': {
      const facts = await gatherClusterHealthFacts(incidentId);
      const summary = facts.currentLogs?.split('\n')[0] ?? 'Cluster health gathered';
      return {
        tool: toolCall.name,
        summary,
        data: facts,
      };
    }
    case 'investigator.get_namespace_health': {
      const ns = (toolCall.input?.namespace as string) ?? namespace;
      const facts = await gatherNamespaceHealthFacts(ns, incidentId);
      return {
        tool: toolCall.name,
        summary: `Namespace ${ns} health snapshot gathered`,
        data: facts,
      };
    }
    case 'investigator.logs_query': {
      const target = await resolveWorkloadGatherTarget(namespace, resourceName, kind, incidentId);
      const logs = await queryLogs({
        incidentId,
        namespace,
        podName: target.podName,
        sinceMinutes: (toolCall.input?.sinceMinutes as number) ?? 30,
        limit: 100,
      });
      const excerpt = logs.lines.join('\n').slice(0, 4000);
      const enriched = enrichFactsWithPrimaryFailure({
        currentLogs: excerpt,
        observabilitySummary: excerpt.slice(0, 500),
        incidentId,
        namespace,
        resourceName,
      });
      const primary = extractPrimaryFailure(enriched);
      return {
        tool: toolCall.name,
        summary: primary
          ? primary.summary
          : excerpt
            ? `Log excerpt (${logs.lines.length} lines from ${logs.source})`
            : 'No logs returned (container may not have started yet)',
        data: enriched,
        primaryFinding: primary ? formatPrimaryFailureMessage(primary) : undefined,
      };
    }
    case 'investigator.metrics_query': {
      const metrics = await queryMetrics({ namespace, deployment: resourceName });
      return {
        tool: toolCall.name,
        summary: metrics.summary?.slice(0, 200) ?? 'Metrics query completed',
        data: {
          observabilitySummary: metrics.summary,
          incidentId,
          namespace,
          resourceName,
        },
      };
    }
    default:
      throw new Error(`Unknown read tool: ${(toolCall as AgentReadToolCall).name}`);
  }
}

/** Full batch gather — classic fallback inside agent-step endpoint. */
export async function gatherBatchFacts(opts: {
  incidentId: string;
  namespace: string;
  resourceName: string;
  resourceKind: import('../../../shared/src/types.js').ResourceKind;
  mode: import('../../../shared/src/types.js').IncidentMode;
  rawMessage?: string;
}): Promise<DiagnosisContext> {
  return gatherFactsSync({
    incidentId: opts.incidentId,
    namespace: opts.namespace,
    resourceName: opts.resourceName,
    resourceKind: opts.resourceKind,
    mode: opts.mode,
    rawMessage: opts.rawMessage,
  });
}

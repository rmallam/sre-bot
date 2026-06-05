/**
 * Heuristic fallback for agent-next-read when LLM unavailable.
 */

import type { DiagnosisContext } from '../../../shared/src/types.js';
import type { AgentNextReadRequest, AgentNextReadResponse } from './agent-loop.js';

function hasImagePullBackOff(evidence: Partial<DiagnosisContext>): boolean {
  const statuses = evidence.containerStatuses ?? [];
  return statuses.some((s) => {
    const w = (s as { state?: { waiting?: { reason?: string } } }).state?.waiting;
    return w?.reason === 'ImagePullBackOff' || w?.reason === 'ErrImagePull';
  });
}

export function heuristicAgentNextRead(req: AgentNextReadRequest): AgentNextReadResponse {
  const { fetchedTools, evidence, userHints, priorSteps, maxSteps = 20 } = req;

  if (priorSteps.length >= maxSteps) {
    return { done: true, summary: 'Reached investigation step limit', reasoning: 'max_steps' };
  }

  if (!fetchedTools.includes('investigator.get_workload')) {
    return {
      done: false,
      toolCall: { name: 'investigator.get_workload' },
      summary: 'Checking workload and container status…',
      reasoning: 'heuristic_workload',
    };
  }

  if (!fetchedTools.includes('investigator.get_events')) {
    return {
      done: false,
      toolCall: { name: 'investigator.get_events' },
      summary: 'Reviewing recent Kubernetes events…',
      reasoning: 'heuristic_events',
    };
  }

  if (hasImagePullBackOff(evidence) && !userHints?.length) {
    return {
      done: true,
      summary:
        'Image pull failure detected — need correct image registry/tag or pull secret from you.',
      reasoning: 'heuristic_image_pull',
    };
  }

  if (!fetchedTools.includes('investigator.logs_query') && priorSteps.length < 5) {
    return {
      done: false,
      toolCall: { name: 'investigator.logs_query', input: { sinceMinutes: 30 } },
      summary: 'Fetching container logs…',
      reasoning: 'heuristic_logs',
    };
  }

  if (!fetchedTools.includes('investigator.metrics_query') && priorSteps.length < 7) {
    return {
      done: false,
      toolCall: { name: 'investigator.metrics_query' },
      summary: 'Checking workload metrics…',
      reasoning: 'heuristic_metrics',
    };
  }

  return {
    done: true,
    summary: 'Enough evidence gathered to plan remediation',
    reasoning: 'heuristic_sufficient',
  };
}

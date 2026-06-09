/**
 * Heuristic fallback for agent-next-read when LLM unavailable.
 */

import type { DiagnosisContext } from '../../../shared/src/types.js';
import { extractPrimaryFailure } from '../../../shared/src/investigation-diagnosis.js';
import type { AgentNextReadRequest, AgentNextReadResponse } from './agent-loop.js';

function hasTerminalFailure(evidence: Partial<DiagnosisContext>): boolean {
  const primary = extractPrimaryFailure(evidence);
  return primary?.terminal === true;
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

  const primaryAfterWorkload = extractPrimaryFailure(evidence);
  if (primaryAfterWorkload?.terminal && !fetchedTools.includes('investigator.get_events')) {
    return {
      done: false,
      toolCall: { name: 'investigator.get_events' },
      summary: `${primaryAfterWorkload.summary} — confirming from events…`,
      reasoning: 'heuristic_events_after_terminal',
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

  const primary = extractPrimaryFailure(evidence);
  if (primary?.suggestedAction === 'ask_image' && !userHints?.length) {
    return {
      done: true,
      summary: `${primary.summary}. Reply with the correct image tag or pull secret.`,
      reasoning: 'heuristic_image_pull',
    };
  }

  if (hasTerminalFailure(evidence)) {
    return {
      done: true,
      summary: primary?.summary ?? 'Terminal failure identified — ready to plan fix',
      reasoning: 'heuristic_terminal_failure',
    };
  }

  if (!fetchedTools.includes('investigator.logs_query') && priorSteps.length < 5) {
    const sig = extractPrimaryFailure(evidence);
    if (
      sig?.suggestedAction !== 'ask_image' &&
      sig?.signature !== 'ImagePullBackOff' &&
      !hasTerminalFailure(evidence)
    ) {
      return {
        done: false,
        toolCall: { name: 'investigator.logs_query', input: { sinceMinutes: 30 } },
        summary: 'Fetching container logs…',
        reasoning: 'heuristic_logs',
      };
    }
  }

  if (!fetchedTools.includes('investigator.metrics_query') && priorSteps.length < 7) {
    const sig = extractPrimaryFailure(evidence);
    if (sig?.suggestedAction !== 'ask_image' && !hasTerminalFailure(evidence)) {
      return {
        done: false,
        toolCall: { name: 'investigator.metrics_query' },
        summary: 'Checking workload metrics…',
        reasoning: 'heuristic_metrics',
      };
    }
  }

  return {
    done: true,
    summary: 'Enough evidence gathered to plan remediation',
    reasoning: 'heuristic_sufficient',
  };
}

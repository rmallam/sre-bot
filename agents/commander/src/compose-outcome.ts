/**
 * UX-18 — Turn structured command outcomes into chat-friendly messages.
 */

import type { CommandOutcome, ComposeOptions } from '../../../shared/src/command-outcome.js';
import { formatCommandOutcomeFallback } from '../../../shared/src/compose-outcome-fallback.js';
import { log } from '../../../shared/src/http.js';
import { resolveCommanderLlm } from '../../../shared/src/llm-config.js';
import { openRouterChat, stripJsonFences } from '../../../shared/src/openrouter.js';

const AGENT = 'commander-compose';

const COMPOSE_LLM =
  (process.env['CONVERSATIONAL_COMPOSE_LLM'] ?? process.env['CONVERSATIONAL_NARRATE_LLM'] ?? 'true')
    .toLowerCase() === 'true';

const SYSTEM = `You write short, friendly chat replies for an SRE assistant (Slack/Telegram/web).

Rules:
- Sound like a helpful colleague, not a log dump or runbook.
- Lead with the answer in the first sentence.
- 1 short paragraph for brief mode; add bullet details only when verbose is true.
- Use **bold** for workload names and namespaces. Use \`code\` only for kubectl examples (at most one).
- Do not invent facts — only use the JSON provided.
- Do not mention internal agents, APIs, or tool names.
- For undeploy: say clearly whether Helm and/or kubectl Deployment was involved.
- For errors/not found: be kind and suggest one next step.
- No section headers like "What I did:" — weave actions into natural sentences.
- Max 1200 characters unless verbose is true (then max 3500).`;

export async function composeUserReply(
  outcome: CommandOutcome,
  opts: ComposeOptions = {}
): Promise<string> {
  const fallback = formatCommandOutcomeFallback(outcome, opts);

  if (
    !COMPOSE_LLM ||
    outcome.kind === 'plain' ||
    outcome.kind === 'choice_prompt' ||
    outcome.kind === 'cluster_get' ||
    outcome.kind === 'health' ||
    outcome.kind === 'event_investigation' ||
    outcome.kind === 'app_review'
  ) {
    return fallback;
  }

  try {
    resolveCommanderLlm();
  } catch {
    return fallback;
  }

  try {
    const raw = await openRouterChat({
      model: resolveCommanderLlm().model,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `Write the user message. verbose=${opts.verbose === true}\n\nFallback reference (match facts, improve tone):\n${fallback}\n\nJSON:\n${JSON.stringify(outcome, null, 2)}`,
        },
      ],
      jsonMode: false,
      temperature: 0.35,
      callerAgent: AGENT,
      incidentId: opts.incidentId ?? 'compose',
    });
    const text = stripJsonFences(raw).trim();
    if (text.length < 8) return fallback;
    return text.slice(0, opts.verbose ? 4000 : 2000);
  } catch (err) {
    log('warn', AGENT, 'LLM compose failed, using fallback', {
      incidentId: opts.incidentId ?? 'compose',
      error: String(err),
    });
    return fallback;
  }
}

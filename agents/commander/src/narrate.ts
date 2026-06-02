/**
 * UX-1: Turn structured run updates into natural chat messages.
 */

import type { RunUpdatePayload } from '../../../shared/src/run-update.js';
import { formatRunUpdateFallback } from '../../../shared/src/run-update.js';
import { log } from '../../../shared/src/http.js';
import { resolveCommanderLlm } from '../../../shared/src/llm-config.js';
import { openRouterChat, stripJsonFences } from '../../../shared/src/openrouter.js';

const AGENT = 'commander-narrate';

const NARRATE_LLM = (process.env['CONVERSATIONAL_NARRATE_LLM'] ?? 'true').toLowerCase() === 'true';

const SYSTEM = `You write short Telegram/Slack messages for an SRE assistant.

Rules:
- 2-5 sentences max unless the user needs critical log lines (max 3 lines of log).
- Plain language. No internal tool names (cicd_rerun, investigator.verify_health, etc.).
- No "Category: transient_infra" — explain what happened and what the user can do.
- Use markdown sparingly: bold for actions, one link if provided in input.
- Do not invent facts not present in the JSON input.
- If approval is needed, say what will happen when they approve.
- If detailAvailable is true and verbose is false, do NOT paste log lines — mention they can tap Show logs.
- If verbose is true, you may include up to 5 log lines from errorHighlight.`;

export async function narrateRunUpdate(payload: RunUpdatePayload): Promise<string> {
  const fallback = formatRunUpdateFallback(payload);

  if (!NARRATE_LLM) {
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
          content: `Turn this run update into a user message. Fallback for reference:\n${fallback}\n\nJSON:\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
      jsonMode: false,
      temperature: 0.3,
      callerAgent: AGENT,
      incidentId: payload.incidentId,
    });
    const text = stripJsonFences(raw).trim();
    if (text.length < 10) return fallback;
    return text.slice(0, 4000);
  } catch (err) {
    log('warn', AGENT, 'LLM narrate failed, using fallback', {
      incidentId: payload.incidentId,
      error: String(err),
    });
    return fallback;
  }
}

/**
 * Enrich investigate commands with container image hints (LLM + rules).
 */

import type { ParsedCommand } from './parser.js';
import {
  looksLikeImageRemediation,
  resolveOperatorSuggestion,
} from './investigate-target.js';
import { extractContainerImageViaLlm } from './image-hint-llm.js';

export async function enrichInvestigateImageHint(
  parsed: ParsedCommand,
  text: string,
  userId: string,
  ctx: {
    transcript?: Array<{ role: 'user' | 'assistant'; content: string }>;
  } = {}
): Promise<ParsedCommand> {
  if (parsed.type !== 'investigate') return parsed;

  const workloadHint =
    parsed.workloadHint ??
    (parsed.resourceName && !parsed.resourceName.startsWith('_') ? parsed.resourceName : undefined);

  if (parsed.operatorSuggestion) return parsed;
  if (!looksLikeImageRemediation(text)) return parsed;

  const fromRules = resolveOperatorSuggestion({ text, workloadHint });
  if (fromRules) {
    return { ...parsed, operatorSuggestion: fromRules };
  }

  const fromLlm = await extractContainerImageViaLlm(text, userId, {
    workloadHint,
    namespace: parsed.namespace !== '_all' ? parsed.namespace : undefined,
    transcript: ctx.transcript,
  });
  if (!fromLlm) return parsed;

  return { ...parsed, operatorSuggestion: `set image to ${fromLlm}` };
}

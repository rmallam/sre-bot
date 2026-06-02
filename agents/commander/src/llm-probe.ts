/**
 * UX-11 — Probe commander LLM on startup; fail loud if router model is unavailable.
 */

import { resolveCommanderLlm } from '../../../shared/src/llm-config.js';
import { log } from '../../../shared/src/http.js';

const AGENT = 'commander-llm-probe';
const GEMINI_API_KEY = process.env['GEMINI_API_KEY'];

export interface CommanderLlmProbeResult {
  ok: boolean;
  backend?: string;
  model?: string;
  error?: string;
  hint?: string;
}

let lastProbe: CommanderLlmProbeResult | null = null;

export function getLastCommanderLlmProbe(): CommanderLlmProbeResult | null {
  return lastProbe;
}

export async function probeCommanderLlm(): Promise<CommanderLlmProbeResult> {
  let llm: ReturnType<typeof resolveCommanderLlm>;
  try {
    llm = resolveCommanderLlm();
  } catch (err) {
    lastProbe = {
      ok: false,
      error: String(err),
      hint: 'Set OPENROUTER_API_KEY or GEMINI_API_KEY for natural language routing.',
    };
    return lastProbe;
  }

  const probeJson = '{"intent":"chat","confidence":1,"userReply":"ok"}';

  try {
    if (llm.backend === 'openrouter') {
      const { openRouterChat } = await import('../../../shared/src/openrouter.js');
      await openRouterChat({
        model: llm.model,
        messages: [
          {
            role: 'system',
            content: 'Reply with ONLY valid JSON: {"intent":"chat","confidence":1,"userReply":"ok"}',
          },
          { role: 'user', content: 'ping' },
        ],
        jsonMode: true,
        temperature: 0,
        callerAgent: AGENT,
        incidentId: 'startup-probe',
      });
    } else if (llm.backend === 'gemini' && GEMINI_API_KEY) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${llm.model}:generateContent?key=${GEMINI_API_KEY}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Reply ONLY: ${probeJson}` }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
    } else {
      throw new Error('Gemini backend selected but GEMINI_API_KEY is missing');
    }

    lastProbe = { ok: true, backend: llm.backend, model: llm.model };
    log('info', AGENT, 'Commander LLM probe succeeded', lastProbe);
    return lastProbe;
  } catch (err) {
    const message = String(err);
    lastProbe = {
      ok: false,
      backend: llm.backend,
      model: llm.model,
      error: message,
      hint:
        message.includes('no longer available') || message.includes('404')
          ? 'Update GEMINI_COMMANDER_MODEL to gemini-2.5-flash (see secrets.example.yaml).'
          : 'Check API key and model name; NL routing will fall back to regex only.',
    };
    log('error', AGENT, 'Commander LLM probe FAILED — natural language routing degraded', lastProbe);
    return lastProbe;
  }
}

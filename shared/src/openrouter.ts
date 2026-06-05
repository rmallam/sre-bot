/**
 * OpenRouter chat completions helper (shared by brain + commander).
 */

import { log } from './http.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export async function openRouterChat(opts: {
  model: string;
  messages: OpenRouterMessage[];
  temperature?: number;
  jsonMode?: boolean;
  callerAgent: string;
  incidentId?: string;
}): Promise<string> {
  const apiKey = process.env['OPENROUTER_API_KEY']?.trim();
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }

  const maxTokens = parseInt(process.env['OPENROUTER_MAX_TOKENS'] ?? '1024', 10);
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.1,
    max_tokens: Number.isFinite(maxTokens) ? maxTokens : 1024,
  };
  if (opts.jsonMode) {
    body['response_format'] = { type: 'json_object' };
  }

  log('info', opts.callerAgent, 'OpenRouter request', {
    incidentId: opts.incidentId ?? 'N/A',
    model: opts.model,
    jsonMode: Boolean(opts.jsonMode),
  });

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': process.env['OPENROUTER_HTTP_REFERER'] ?? 'https://github.com/rmallam/sre-bot',
      'X-Title': process.env['OPENROUTER_APP_TITLE'] ?? 'Kube SRE Bot',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`OpenRouter HTTP ${res.status}: ${errBody.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const raw = data.choices?.[0]?.message?.content;
  if (!raw?.trim()) {
    throw new Error(`OpenRouter returned empty content: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return raw;
}

/** Strip markdown fences from JSON responses. */
export function stripJsonFences(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
  }
  return cleaned;
}

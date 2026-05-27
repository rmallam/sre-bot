/**
 * LLM intent router — uses security-agent sanitize + optional Gemini/OpenRouter.
 */

import type { Platform } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import { parseCommand, extractGithubRepo, type ParsedCommand } from './parser.js';

const SECURITY_URL = process.env['SECURITY_URL'] ?? 'http://security-agent:8080';
const GEMINI_API_KEY = process.env['GEMINI_API_KEY'];
const OPENROUTER_API_KEY = process.env['OPENROUTER_API_KEY'];

export interface LlmRouteResult {
  parsed: ParsedCommand;
  conversationalReply?: string;
  confidence: number;
}

export async function routeMessage(
  text: string,
  platform: Platform,
  userId: string
): Promise<LlmRouteResult> {
  // Sanitize user text before any LLM call
  try {
    const res = await fetch(`${SECURITY_URL}/sanitize-for-llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, incidentId: `chat-${userId}` }),
    });
    if (res.ok) {
      const data = (await res.json()) as { sanitizedText?: string; blocked?: boolean };
      if (data.blocked) {
        return {
          parsed: { type: 'unknown' },
          conversationalReply: 'I cannot process that message due to security policy.',
          confidence: 1,
        };
      }
      if (data.sanitizedText) text = data.sanitizedText;
    }
  } catch (err) {
    log('warn', 'commander-llm-router', 'Sanitize failed, using regex only', { error: String(err) });
  }

  // Fast path: regex
  const regexParsed = parseCommand(text);
  if (regexParsed.type !== 'unknown') {
    return { parsed: regexParsed, confidence: 0.9 };
  }

  // Optional LLM fallback for free speech
  if (!GEMINI_API_KEY && !OPENROUTER_API_KEY) {
    return {
      parsed: regexParsed,
      conversationalReply:
        "I'm your SRE assistant. Try: deploy github.com/org/repo, investigate namespace/app, or rollback staging/api.",
      confidence: 0.3,
    };
  }

  const llmText = await classifyWithLlm(text);
  const githubRepo = extractGithubRepo(text);
  const wantsDeploy = /\b(deploy|ship|release|install|launch)\b/i.test(text) || llmText.toLowerCase().includes('deploy');

  if (githubRepo && wantsDeploy) {
    const deploy = parseCommand(text.includes('deploy') ? text : `deploy ${text}`);
    if (deploy.type === 'deploy') {
      return { parsed: deploy, confidence: 0.85 };
    }
  }

  if (/status|how.*going|update/i.test(text)) {
    return {
      parsed: { type: 'unknown' },
      conversationalReply: 'Check the HIL dashboard or your last incident ID for status.',
      confidence: 0.6,
    };
  }

  return {
    parsed: regexParsed,
    conversationalReply: llmText.slice(0, 500) || "Tell me what to deploy, investigate, or rollback.",
    confidence: 0.5,
  };
}

async function classifyWithLlm(text: string): Promise<string> {
  if (OPENROUTER_API_KEY) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env['OPENROUTER_MODEL'] ?? 'google/gemini-2.0-flash-001',
        messages: [
          {
            role: 'system',
            content:
              'You are an SRE PA. Reply briefly. If user wants deploy/investigate/rollback, say which intent.',
          },
          { role: 'user', content: text },
        ],
        temperature: 0.2,
      }),
    });
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  }
  return '';
}

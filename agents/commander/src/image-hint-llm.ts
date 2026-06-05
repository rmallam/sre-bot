/**
 * Focused LLM extraction for container image refs when rule-based parsing misses intent.
 */

import { log } from '../../../shared/src/http.js';
import { resolveCommanderLlm } from '../../../shared/src/llm-config.js';
import { openRouterChat, stripJsonFences } from '../../../shared/src/openrouter.js';
import { normalizeContainerImageRef } from './investigate-target.js';

const AGENT = 'commander-image-hint';
const GEMINI_API_KEY = process.env['GEMINI_API_KEY'];

const IMAGE_HINT_SYSTEM = `You extract Kubernetes container image references from SRE chat messages.
Reply with ONLY valid JSON:
{
  "containerImage": "full OCI reference (registry/path:tag) or null",
  "confidence": 0.0 to 1.0
}
Rules:
- Expand shorthand: "vyogotech ghcr latest" + workload frappe-operator → ghcr.io/vyogotech/frappe-operator:latest
- "use the latest from GHCR under acme" + workload my-app → ghcr.io/acme/my-app:latest
- Pass through full refs unchanged (ghcr.io/org/repo:v1.2.3, docker.io/library/nginx:latest)
- Use workloadHint/namespace context when the user omits repo name or registry
- containerImage null when the message is not about changing or specifying an image
- Never invent org/repo not implied by the message or context`;

export interface ImageHintContext {
  workloadHint?: string;
  namespace?: string;
  transcript?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface ImageHintResult {
  containerImage: string | null;
  confidence: number;
}

function parseImageHintJson(raw: string): ImageHintResult | null {
  try {
    const parsed = JSON.parse(stripJsonFences(raw).trim()) as Partial<ImageHintResult>;
    const containerImage =
      typeof parsed.containerImage === 'string' && parsed.containerImage.trim()
        ? normalizeContainerImageRef(parsed.containerImage)
        : parsed.containerImage === null
          ? null
          : null;
    const confidence =
      typeof parsed.confidence === 'number'
        ? Math.min(1, Math.max(0, parsed.confidence))
        : containerImage
          ? 0.75
          : 0;
    return { containerImage, confidence };
  } catch {
    return null;
  }
}

/** Second-pass LLM when unified intent / regex did not produce an image ref. */
export async function extractContainerImageViaLlm(
  text: string,
  userId: string,
  ctx: ImageHintContext = {}
): Promise<string | null> {
  try {
    const llm = resolveCommanderLlm();
    const contextBlock = [
      ctx.workloadHint ? `workloadHint: ${ctx.workloadHint}` : '',
      ctx.namespace ? `namespace: ${ctx.namespace}` : '',
      ctx.transcript?.length
        ? `recentTurns: ${JSON.stringify(ctx.transcript.slice(-6))}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const userContent = contextBlock ? `${text}\n\nContext:\n${contextBlock}` : text;
    let raw = '';

    if (llm.backend === 'openrouter') {
      raw = await openRouterChat({
        model: llm.model,
        messages: [
          { role: 'system', content: IMAGE_HINT_SYSTEM },
          { role: 'user', content: userContent },
        ],
        jsonMode: true,
        temperature: 0.05,
        callerAgent: AGENT,
        incidentId: `chat-${userId}`,
      });
    } else if (llm.backend === 'gemini' && GEMINI_API_KEY) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${llm.model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${IMAGE_HINT_SYSTEM}\n\nUser: ${userContent}` }] }],
            generationConfig: { temperature: 0.05, responseMimeType: 'application/json' },
          }),
        }
      );
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    } else {
      return null;
    }

    const parsed = parseImageHintJson(raw);
    if (!parsed?.containerImage || parsed.confidence < 0.45) return null;
    return parsed.containerImage;
  } catch (err) {
    log('warn', AGENT, 'Image hint LLM extraction failed', { error: String(err) });
    return null;
  }
}

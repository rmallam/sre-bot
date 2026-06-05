/**
 * UX-13 — Rolling chat transcript per user/channel for LLM context.
 */

import { getSession, setSession, type ChatTurn } from './sessions.js';

export type { ChatTurn };

const MAX_TURNS = parseInt(process.env['CHAT_TRANSCRIPT_MAX_TURNS'] ?? '40', 10);
const MAX_CHARS = parseInt(process.env['CHAT_TRANSCRIPT_MAX_CHARS'] ?? '6000', 10);

export function trimTranscript(turns: ChatTurn[]): ChatTurn[] {
  let slice = turns.slice(-MAX_TURNS);
  while (slice.length > 1) {
    const chars = slice.reduce((n, t) => n + t.content.length, 0);
    if (chars <= MAX_CHARS) break;
    slice = slice.slice(1);
  }
  return slice;
}

export async function appendChatTurn(
  platform: string,
  channelId: string,
  userId: string,
  turn: ChatTurn
): Promise<void> {
  const session = await getSession(platform, channelId, userId);
  const prev = session?.transcript ?? [];
  await setSession(platform, channelId, userId, {
    transcript: trimTranscript([...prev, turn]),
  });
}

export async function recordUserMessage(
  platform: string,
  channelId: string,
  userId: string,
  content: string
): Promise<void> {
  await appendChatTurn(platform, channelId, userId, {
    role: 'user',
    content: content.trim().slice(0, 2000),
    at: new Date().toISOString(),
  });
}

export async function recordAssistantMessage(
  platform: string,
  channelId: string,
  userId: string,
  content: string
): Promise<void> {
  await appendChatTurn(platform, channelId, userId, {
    role: 'assistant',
    content: content.trim().slice(0, 4000),
    at: new Date().toISOString(),
  });
}

export async function getChatTranscriptForLlm(
  platform: string,
  channelId: string,
  userId: string
): Promise<ChatTurn[]> {
  const session = await getSession(platform, channelId, userId);
  return (session?.transcript ?? []).filter((t) => t.role !== 'status');
}

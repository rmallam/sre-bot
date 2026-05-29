/**
 * In-memory session store for conversational PA (v1).
 * v2: replace with Redis.
 */

export interface ChatSession {
  activeRunId?: string;
  pendingQuestion?: string;
  lastIncidentId?: string;
  /** Last deploy intent for branch/strategy follow-ups. */
  lastDeployDraft?: import('./parser.js').DeployCmd;
  updatedAt: string;
}

const sessions = new Map<string, ChatSession>();

function key(platform: string, channelId: string, userId: string): string {
  return `${platform}:${channelId}:${userId}`;
}

export function getSession(platform: string, channelId: string, userId: string): ChatSession | undefined {
  return sessions.get(key(platform, channelId, userId));
}

export function setSession(
  platform: string,
  channelId: string,
  userId: string,
  patch: Partial<ChatSession>
): ChatSession {
  const k = key(platform, channelId, userId);
  const existing = sessions.get(k) ?? { updatedAt: new Date().toISOString() };
  const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  sessions.set(k, next);
  return next;
}

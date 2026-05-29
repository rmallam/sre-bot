/**
 * Tracks users who clicked "Suggest fix" and are waiting to type their remediation.
 */

const TTL_MS = parseInt(process.env['HIL_SUGGEST_TTL_MS'] ?? '600000', 10);

interface PendingSuggest {
  incidentId: string;
  platform: 'telegram' | 'slack';
  channelId: string;
  userId: string;
  expiresAt: number;
}

const pending = new Map<string, PendingSuggest>();

function key(platform: string, channelId: string, userId: string): string {
  return `${platform}:${channelId}:${userId}`;
}

export function storeHilSuggestPrompt(
  platform: 'telegram' | 'slack',
  channelId: string,
  userId: string,
  incidentId: string
): void {
  pending.set(key(platform, channelId, userId), {
    incidentId,
    platform,
    channelId,
    userId,
    expiresAt: Date.now() + TTL_MS,
  });
}

export function clearHilSuggestPrompt(
  platform: string,
  channelId: string,
  userId: string
): void {
  pending.delete(key(platform, channelId, userId));
}

export function getHilSuggestIncident(
  platform: string,
  channelId: string,
  userId: string
): string | undefined {
  const entry = pending.get(key(platform, channelId, userId));
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    pending.delete(key(platform, channelId, userId));
    return undefined;
  }
  return entry.incidentId;
}

export type ResolveSuggestResult =
  | { status: 'none' }
  | { status: 'ready'; incidentId: string; suggestion: string };

export function tryConsumeSuggestReply(
  platform: 'telegram' | 'slack',
  channelId: string,
  userId: string,
  text: string
): ResolveSuggestResult {
  const incidentId = getHilSuggestIncident(platform, channelId, userId);
  if (!incidentId) return { status: 'none' };
  if (text.trim().toLowerCase() === 'cancel') {
    clearHilSuggestPrompt(platform, channelId, userId);
    return { status: 'none' };
  }
  clearHilSuggestPrompt(platform, channelId, userId);
  return { status: 'ready', incidentId, suggestion: text.trim() };
}

export function buildSuggestFixPrompt(incidentId: string): string {
  return (
    `✏️ Suggest a fix for incident \`${incidentId}\`\n\n` +
    `Reply with what you want done, for example:\n` +
    `• restart the deployment\n` +
    `• add imagePullSecrets ghcr-creds\n` +
    `• set image to ghcr.io/org/app:v1.2.3\n` +
    `• scale to 2\n\n` +
    `I'll parse it, show the plan, then you can tap **Apply my fix** or **Approve**.\n` +
    `Send \`cancel\` to stop.`
  );
}

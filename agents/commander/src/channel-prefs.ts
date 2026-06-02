/**
 * UX-9 — Per-channel verbosity preference.
 */

export interface ChannelPrefs {
  verbose: boolean;
}

const prefs = new Map<string, ChannelPrefs>();

function key(platform: string, channelId: string): string {
  return `${platform}:${channelId}`;
}

export function getChannelPref(platform: string, channelId: string): ChannelPrefs {
  return prefs.get(key(platform, channelId)) ?? { verbose: false };
}

export function setChannelPref(platform: string, channelId: string, patch: Partial<ChannelPrefs>): ChannelPrefs {
  const k = key(platform, channelId);
  const next = { ...getChannelPref(platform, channelId), ...patch };
  prefs.set(k, next);
  return next;
}

/** "be brief" / "more detail" chat commands. */
export function tryPrefFollowUp(
  platform: string,
  channelId: string,
  text: string
): string | null {
  const t = text.trim().toLowerCase();
  if (/\b(be brief|keep it short|less detail|shorter messages)\b/.test(t)) {
    setChannelPref(platform, channelId, { verbose: false });
    return "Got it — I'll keep messages brief. Say \"more detail\" anytime.";
  }
  if (/\b(more detail|be verbose|show more|verbose mode)\b/.test(t)) {
    setChannelPref(platform, channelId, { verbose: true });
    return "Got it — I'll include more detail when available.";
  }
  return null;
}

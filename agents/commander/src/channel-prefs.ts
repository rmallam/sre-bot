/**
 * UX-9 — Per-channel verbosity preference.
 */

export interface ChannelPrefs {
  verbose: boolean;
  /** AGENT-8 — override SRE_AGENT_MODE for this channel. */
  agentMode?: 'classic' | 'agentic';
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

/** AGENT-8 — "use agentic mode" / "use classic mode" chat commands. */
export function tryAgentModeFollowUp(
  platform: string,
  channelId: string,
  text: string
): string | null {
  const t = text.trim().toLowerCase();
  if (/\b(use agentic|agentic mode|enable agentic)\b/.test(t)) {
    setChannelPref(platform, channelId, { agentMode: 'agentic' });
    return 'Agentic mode enabled for this channel — investigations use the tool loop and ReAct graph.';
  }
  if (/\b(use classic|classic mode|disable agentic)\b/.test(t)) {
    setChannelPref(platform, channelId, { agentMode: 'classic' });
    return 'Classic mode enabled for this channel — standard batch investigate pipeline.';
  }
  if (/\b(clear agent mode|reset agent mode)\b/.test(t)) {
    setChannelPref(platform, channelId, { agentMode: undefined });
    return 'Agent mode override cleared — using cluster default from SRE_AGENT_MODE.';
  }
  return null;
}

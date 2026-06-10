import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  createChatSession,
  fetchChatSession,
  listChatSessions,
  resetChatSession,
  sendChatMessage,
  type ChatSessionSummary,
  type ChatTurn,
} from '../api';
import { ChatMessageBubble } from '../components/ChatMessageBubble';
import { ChatHistoryPanel } from '../components/ChatHistoryPanel';
import { ChatSessionTabs } from '../components/ChatSessionTabs';

const STORAGE_KEY = 'sre-console-active-channel';
const TABS_KEY = 'sre-console-chat-tabs';

function turnKey(turn: ChatTurn, index: number): string {
  if (turn.updateKind === 'run_logs' && turn.runId) {
    return `logs-${turn.runId}`;
  }
  if (turn.liveUpdate && turn.incidentId) {
    return `live-${turn.incidentId}`;
  }
  return `${turn.at}-${turn.role}-${index}`;
}

function loadOpenTabs(): string[] {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveOpenTabs(tabs: string[]): void {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(tabs));
  } catch {
    /* ignore */
  }
}

export function ChatPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  /** Local-only panels (run logs) — not overwritten by transcript polling. */
  const [ephemeralTurns, setEphemeralTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [waitingForRun, setWaitingForRun] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  /** Turns that should not typewriter-animate (history or already shown). */
  const seenTurnKeysRef = useRef<Set<string>>(new Set());
  const prevTurnCountRef = useRef(0);
  const [animatingKey, setAnimatingKey] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<string[]>(() => loadOpenTabs());
  const [historyOpen, setHistoryOpen] = useState(false);

  const markTurnsSeen = useCallback((list: ChatTurn[], upToIndex?: number) => {
    const limit = upToIndex ?? list.length;
    for (let i = 0; i < limit; i++) {
      seenTurnKeysRef.current.add(turnKey(list[i]!, i));
    }
  }, []);

  const applyTranscript = useCallback(
    (list: ChatTurn[], opts?: { markAllSeen?: boolean }) => {
      if (opts?.markAllSeen) {
        markTurnsSeen(list);
        setAnimatingKey(null);
      } else {
        // New assistant messages since last snapshot get typewriter.
        const prevCount = prevTurnCountRef.current;
        let nextAnimate: string | null = null;
        for (let i = prevCount; i < list.length; i++) {
          const t = list[i]!;
          if (t.role === 'assistant') {
            const key = turnKey(t, i);
            if (t.liveUpdate && seenTurnKeysRef.current.has(key)) {
              continue;
            }
            if (!seenTurnKeysRef.current.has(key)) {
              nextAnimate = key;
            }
          }
        }
        setAnimatingKey(nextAnimate);
      }
      prevTurnCountRef.current = list.length;
      setTurns(list);
    },
    [markTurnsSeen]
  );

  const scrollDown = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const displayTurns = useMemo(() => [...turns, ...ephemeralTurns], [turns, ephemeralTurns]);

  const handleShowLogs = useCallback(
    (text: string, runId: string) => {
      const content = text.trim() || 'No logs available for this run.';
      setEphemeralTurns((prev) => {
        const rest = prev.filter((t) => !(t.updateKind === 'run_logs' && t.runId === runId));
        return [
          ...rest,
          {
            role: 'assistant' as const,
            content,
            at: new Date().toISOString(),
            runId,
            updateKind: 'run_logs',
          },
        ];
      });
      scrollDown();
    },
    [scrollDown]
  );

  const loadTranscript = useCallback(async (cid: string) => {
    const data = await fetchChatSession(cid);
    applyTranscript(data.transcript);
    setWaitingForRun(data.waitingForRun);
    setActiveRunId(data.lastRunId ?? null);
    return data;
  }, [applyTranscript]);

  const refreshSessions = useCallback(async () => {
    const data = await listChatSessions();
    setSessions(data.sessions);
    return data.sessions;
  }, []);

  const addToTabs = useCallback((cid: string) => {
    setOpenTabs((prev) => {
      if (prev.includes(cid)) return prev;
      const next = [...prev, cid];
      saveOpenTabs(next);
      return next;
    });
  }, []);

  const selectChannel = useCallback(
    async (cid: string) => {
      setChannelId(cid);
      addToTabs(cid);
      localStorage.setItem(STORAGE_KEY, cid);
      setSearchParams({}, { replace: true });
      setError(null);
      seenTurnKeysRef.current = new Set();
      prevTurnCountRef.current = 0;
      setAnimatingKey(null);
      setEphemeralTurns([]);
      const data = await fetchChatSession(cid);
      applyTranscript(data.transcript, { markAllSeen: true });
      setWaitingForRun(data.waitingForRun);
      setActiveRunId(data.lastRunId ?? null);
    },
    [applyTranscript, setSearchParams, addToTabs]
  );

  const closeTab = useCallback(
    (cid: string) => {
      setOpenTabs((prev) => {
        const next = prev.filter((id) => id !== cid);
        saveOpenTabs(next);
        if (cid === channelId) {
          const fallback = next[next.length - 1];
          if (fallback) {
            void selectChannel(fallback);
          } else {
            setChannelId(null);
            setTurns([]);
          }
        }
        return next;
      });
    },
    [channelId, selectChannel]
  );

  const startNewChat = useCallback(
    async (initialPrompt?: string) => {
      setBootstrapping(true);
      try {
        const created = await createChatSession();
        await refreshSessions();
        setTurns([]);
        await selectChannel(created.channelId);
        if (initialPrompt) {
          setInput(initialPrompt);
        }
      } catch (err) {
        setError(String(err));
      } finally {
        setBootstrapping(false);
      }
    },
    [refreshSessions, selectChannel]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBootstrapping(true);
      try {
        const list = await refreshSessions();
        if (cancelled) return;

        const wantNew = searchParams.get('new') === '1';
        const initialPrompt = searchParams.get('prompt')?.trim() ?? '';
        if (wantNew || list.length === 0) {
          const created = await createChatSession();
          if (cancelled) return;
          list.unshift({
            channelId: created.channelId,
            sessionLabel: created.sessionLabel,
            updatedAt: new Date().toISOString(),
            messageCount: 0,
          });
          setSessions([...list]);
          await selectChannel(created.channelId);
          if (initialPrompt) {
            setInput(initialPrompt);
          }
          return;
        }

        const stored = localStorage.getItem(STORAGE_KEY);
        const pick =
          (stored && list.find((s) => s.channelId === stored)) ?? list[0];
        if (pick) {
          await selectChannel(pick.channelId);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setBootstrapping(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshSessions, selectChannel, searchParams]);

  useEffect(() => {
    scrollDown();
  }, [displayTurns, animatingKey, scrollDown]);

  useEffect(() => {
    if (!channelId || !waitingForRun) return;
    const id = setInterval(() => {
      void loadTranscript(channelId).catch(() => {});
    }, 2000);
    return () => clearInterval(id);
  }, [channelId, waitingForRun, loadTranscript]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading || !channelId) return;

    setInput('');
    setError(null);
    setLoading(true);
    setTurns((prev) => {
      const next = [
        ...prev,
        { role: 'user' as const, content: text, at: new Date().toISOString() },
      ];
      prevTurnCountRef.current = next.length;
      return next;
    });

    try {
      const result = await sendChatMessage(text, channelId);
      if (result.transcript?.length) {
        applyTranscript(result.transcript);
      } else {
        setTurns((prev) => {
          const next = [
            ...prev,
            { role: 'assistant' as const, content: result.reply, at: new Date().toISOString() },
          ];
          const key = turnKey(next[next.length - 1]!, next.length - 1);
          setAnimatingKey(key);
          prevTurnCountRef.current = next.length - 1;
          return next;
        });
      }
      setWaitingForRun(result.waitingForRun ?? false);
      if (result.waitingForRun) {
        void loadTranscript(channelId);
      } else if (result.transcript?.length) {
        const lastWithRun = [...result.transcript].reverse().find((t) => t.runId);
        if (lastWithRun?.runId) setActiveRunId(lastWithRun.runId);
      }
      void refreshSessions();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function onClearChat() {
    if (!channelId) return;
    setLoading(true);
    try {
      const data = await resetChatSession(channelId);
      seenTurnKeysRef.current = new Set();
      prevTurnCountRef.current = 0;
      setAnimatingKey(null);
      setEphemeralTurns([]);
      applyTranscript(data.transcript, { markAllSeen: true });
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="chat-layout">
      <ChatHistoryPanel
        open={historyOpen}
        sessions={sessions}
        activeChannelId={channelId}
        onSelect={(cid) => void selectChannel(cid)}
        onClose={() => setHistoryOpen(false)}
      />

      <div className="chat-main">
        <ChatSessionTabs
          tabs={openTabs.length > 0 ? openTabs : channelId ? [channelId] : []}
          activeChannelId={channelId}
          sessions={sessions}
          onSelect={(cid) => void selectChannel(cid)}
          onClose={closeTab}
        />

        {!bootstrapping && (
          <div className="chat-toolbar">
            {activeRunId && waitingForRun && (
              <Link
                className="chat-active-run-link"
                to={`/runs/${encodeURIComponent(activeRunId)}`}
              >
                Run in progress — view details
              </Link>
            )}
            <div className="chat-toolbar-actions">
              <button
                type="button"
                className={`chat-toolbar-icon-btn${historyOpen ? ' active' : ''}`}
                onClick={() => setHistoryOpen((o) => !o)}
                title="Chat history"
                aria-label="Chat history"
                aria-pressed={historyOpen}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" aria-hidden>
                  <circle cx="8" cy="8" r="5.5" />
                  <path d="M8 4.5V8l2.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                type="button"
                className="chat-toolbar-icon-btn"
                onClick={() => void startNewChat()}
                title="New chat"
                aria-label="New chat"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                  <path d="M8 3v10M3 8h10" strokeLinecap="round" />
                </svg>
              </button>
              {channelId && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm chat-toolbar-action"
                  disabled={loading}
                  onClick={() => void onClearChat()}
                >
                  Clear thread
                </button>
              )}
            </div>
          </div>
        )}

        {bootstrapping ? (
          <div className="chat-empty">Starting assistant…</div>
        ) : !channelId ? (
          <div className="chat-start-panel">
            <h3>What can I help with?</h3>
            <p>Deploy, investigate, check workloads, and triage CI — in plain language.</p>
            <div className="chat-suggestions">
              <button
                type="button"
                className="chat-suggestion"
                onClick={() => void startNewChat('investigate cluster health')}
              >
                Investigate cluster health
              </button>
              <button
                type="button"
                className="chat-suggestion"
                onClick={() => void startNewChat('list pods in all namespaces')}
              >
                List pods in all namespaces
              </button>
              <button
                type="button"
                className="chat-suggestion"
                onClick={() => void startNewChat('help')}
              >
                Show available commands
              </button>
            </div>
            <button type="button" className="btn btn-primary" onClick={() => void startNewChat()}>
              New conversation
            </button>
          </div>
        ) : (
          <div className="chat-panel">
            <div className="chat-thread" role="log" aria-live="polite">
              {displayTurns.length === 0 && !loading && (
                <div className="chat-empty">
                  <p>Ask anything about your cluster, deployments, or incidents.</p>
                  <div className="chat-empty-suggestions">
                    <button type="button" className="chat-chip" onClick={() => setInput('help')}>
                      help
                    </button>
                    <button
                      type="button"
                      className="chat-chip"
                      onClick={() => setInput('investigate cluster health')}
                    >
                      investigate cluster health
                    </button>
                    <button
                      type="button"
                      className="chat-chip"
                      onClick={() => setInput('list pods in all namespaces')}
                    >
                      list pods
                    </button>
                  </div>
                </div>
              )}
              {displayTurns.map((turn, i) => {
                const key = turnKey(turn, i);
                const shouldAnimate =
                  turn.role === 'assistant' &&
                  turn.updateKind !== 'run_logs' &&
                  animatingKey === key;
                return (
                  <ChatMessageBubble
                    key={key}
                    turn={turn}
                    animate={shouldAnimate}
                    onAnimationComplete={() => {
                      seenTurnKeysRef.current.add(key);
                      if (animatingKey === key) setAnimatingKey(null);
                    }}
                    onQuickAction={() => {
                      if (channelId) {
                        void loadTranscript(channelId).then((data) => {
                          setWaitingForRun(data.waitingForRun);
                          setActiveRunId(data.lastRunId ?? null);
                        });
                      }
                    }}
                    onShowLogs={handleShowLogs}
                  />
                );
              })}
              {loading && !turns.some((t) => t.role === 'status') && (
                <div className="chat-message chat-message-assistant">
                  <div className="chat-message-header">
                    <span className="chat-message-role">Assistant</span>
                  </div>
                  <div className="chat-message-body chat-typing">
                    <span className="chat-status-dot" aria-hidden />
                    Thinking…
                  </div>
                </div>
              )}
              {waitingForRun && !loading && !turns.some((t) => t.role === 'status') && (
                <div className="chat-message chat-message-status">
                  <div className="chat-status-line">
                    <span className="chat-status-dot" aria-hidden />
                    Waiting for run updates…
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            <div className="chat-composer-wrap">
              {error && <p className="chat-error">{error}</p>}
              <form className="chat-composer" onSubmit={onSubmit}>
                <textarea
                  className="chat-input"
                  rows={2}
                  placeholder="Ask in plain language…"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void onSubmit(e);
                    }
                  }}
                  disabled={loading}
                />
                <div className="chat-composer-footer">
                  <span className="chat-composer-hint">Enter to send · Shift+Enter for newline</span>
                  <button
                    type="submit"
                    className="btn btn-primary chat-send"
                    disabled={loading || !input.trim()}
                    aria-label="Send message"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                      <path d="M8 12V4M8 4l-3 3M8 4l3 3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

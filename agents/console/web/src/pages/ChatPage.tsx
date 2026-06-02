import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
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

const STORAGE_KEY = 'sre-console-active-channel';

function formatContent(text: string): string {
  const normalized = text.replace(/\n{3,}/g, '\n\n').trim();
  return normalized
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .split('\n\n')
    .map((p) => `<p>${p.replace(/\n/g, '<br />')}</p>`)
    .join('');
}

function formatSessionTitle(s: ChatSessionSummary): string {
  return s.sessionLabel ?? `Chat ${s.channelId.slice(0, 8)}`;
}

export function ChatPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [waitingForRun, setWaitingForRun] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const scrollDown = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const loadTranscript = useCallback(async (cid: string) => {
    const data = await fetchChatSession(cid);
    setTurns(data.transcript);
    setWaitingForRun(data.waitingForRun);
    return data;
  }, []);

  const refreshSessions = useCallback(async () => {
    const data = await listChatSessions();
    setSessions(data.sessions);
    return data.sessions;
  }, []);

  const selectChannel = useCallback(
    async (cid: string) => {
      setChannelId(cid);
      localStorage.setItem(STORAGE_KEY, cid);
      setSearchParams({}, { replace: true });
      setError(null);
      await loadTranscript(cid);
    },
    [loadTranscript, setSearchParams]
  );

  const startNewChat = useCallback(async () => {
    setBootstrapping(true);
    try {
      const created = await createChatSession();
      await refreshSessions();
      setTurns([]);
      await selectChannel(created.channelId);
    } catch (err) {
      setError(String(err));
    } finally {
      setBootstrapping(false);
    }
  }, [refreshSessions, selectChannel]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBootstrapping(true);
      try {
        const list = await refreshSessions();
        if (cancelled) return;

        const wantNew = searchParams.get('new') === '1';
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
  }, [turns, scrollDown]);

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
    setTurns((prev) => [
      ...prev,
      { role: 'user', content: text, at: new Date().toISOString() },
    ]);

    try {
      const result = await sendChatMessage(text, channelId);
      if (result.transcript?.length) {
        setTurns(result.transcript);
      } else {
        setTurns((prev) => [
          ...prev,
          { role: 'assistant', content: result.reply, at: new Date().toISOString() },
        ]);
      }
      setWaitingForRun(result.waitingForRun ?? false);
      if (result.waitingForRun) {
        void loadTranscript(channelId);
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
      setTurns(data.transcript);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="chat-layout">
      <aside className="chat-sidebar">
        <div className="chat-sidebar-header">
          <h3>Conversations</h3>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void startNewChat()}>
            New chat
          </button>
        </div>
        <ul className="chat-session-list">
          {sessions.map((s) => (
            <li key={s.channelId}>
              <button
                type="button"
                className={`chat-session-item ${s.channelId === channelId ? 'active' : ''}`}
                onClick={() => void selectChannel(s.channelId)}
              >
                <span className="chat-session-title">{formatSessionTitle(s)}</span>
                {s.preview && <span className="chat-session-preview">{s.preview}</span>}
              </button>
            </li>
          ))}
        </ul>
        <p className="chat-sidebar-foot">
          <Link to="/">← Back to overview</Link>
        </p>
      </aside>

      <div className="chat-main">
        {bootstrapping ? (
          <div className="chat-empty">Starting assistant…</div>
        ) : !channelId ? (
          <div className="chat-start-panel">
            <h3>SRE Assistant</h3>
            <p>Deploy, investigate, check workloads, and triage CI — in plain language.</p>
            <button type="button" className="btn btn-primary" onClick={() => void startNewChat()}>
              Start a conversation
            </button>
          </div>
        ) : (
          <>
            <div className="chat-toolbar">
              <span className="chat-toolbar-title">
                {sessions.find((s) => s.channelId === channelId)?.sessionLabel ?? 'Assistant'}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={loading}
                onClick={() => void onClearChat()}
              >
                Clear thread
              </button>
            </div>

            <div className="chat-thread" role="log" aria-live="polite">
              {turns.length === 0 && !loading && (
                <div className="chat-empty">
                  Ask anything — e.g.{' '}
                  <button type="button" className="chat-chip" onClick={() => setInput('help')}>
                    help
                  </button>
                  ,{' '}
                  <button
                    type="button"
                    className="chat-chip"
                    onClick={() => setInput('investigate cluster health')}
                  >
                    investigate cluster health
                  </button>
                  , or{' '}
                  <button
                    type="button"
                    className="chat-chip"
                    onClick={() => setInput('is httpd running in any namespace')}
                  >
                    is httpd running in any namespace
                  </button>
                </div>
              )}
              {turns.map((turn, i) => (
                <div
                  key={`${turn.at}-${i}`}
                  className={
                    turn.role === 'user'
                      ? 'chat-bubble chat-bubble-user'
                      : turn.role === 'status'
                        ? 'chat-bubble chat-bubble-status'
                        : 'chat-bubble chat-bubble-assistant'
                  }
                >
                  {turn.role === 'status' ? (
                    <div className="chat-bubble-body chat-status-line">
                      <span className="chat-status-dot" aria-hidden />
                      {turn.content}
                    </div>
                  ) : (
                    <div
                      className="chat-bubble-body"
                      dangerouslySetInnerHTML={{ __html: formatContent(turn.content) }}
                    />
                  )}
                </div>
              ))}
              {loading && !turns.some((t) => t.role === 'status') && (
                <div className="chat-bubble chat-bubble-assistant">
                  <div className="chat-bubble-body chat-typing">Thinking…</div>
                </div>
              )}
              {waitingForRun && !loading && !turns.some((t) => t.role === 'status') && (
                <div className="chat-bubble chat-bubble-status">
                  <div className="chat-bubble-body chat-status-line">
                    <span className="chat-status-dot" aria-hidden />
                    Waiting for run updates…
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

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
              <button
                type="submit"
                className="btn btn-primary chat-send"
                disabled={loading || !input.trim()}
              >
                Send
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

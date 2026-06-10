import { Link } from 'react-router-dom';
import type { ChatTurn } from '../api';
import { StreamingMessage } from './StreamingMessage';
import { ChatQuickActions, type ChatQuickAction } from './ChatQuickActions';

interface Props {
  turn: ChatTurn;
  animate?: boolean;
  onAnimationComplete?: () => void;
  onQuickAction?: () => void;
  onShowLogs?: (text: string, runId: string) => void;
}

export function ChatMessageBubble({
  turn,
  animate = false,
  onAnimationComplete,
  onQuickAction,
  onShowLogs,
}: Props) {
  if (turn.role === 'status') {
    return (
      <div className="chat-message chat-message-status">
        <div className="chat-status-line">
          <span className="chat-status-dot" aria-hidden />
          <span className="chat-status-text">{turn.content}</span>
        </div>
      </div>
    );
  }

  const isUser = turn.role === 'user';
  const isRunLogs = turn.updateKind === 'run_logs';

  return (
    <div className={`chat-message ${isUser ? 'chat-message-user' : 'chat-message-assistant'}${isRunLogs ? ' chat-message-logs' : ''}`}>
      <div className="chat-message-header">
        <span className="chat-message-role">{isUser ? 'You' : isRunLogs ? 'Run logs' : 'Assistant'}</span>
      </div>
      <div className="chat-message-body">
        {turn.role === 'assistant' ? (
          <>
            {isRunLogs ? (
              <pre className="chat-run-logs">{turn.content}</pre>
            ) : (
              <StreamingMessage
                content={turn.content}
                animate={animate}
                onComplete={onAnimationComplete}
              />
            )}
            {turn.quickActions?.length ? (
              <ChatQuickActions
                actions={turn.quickActions as ChatQuickAction[]}
                incidentId={turn.incidentId}
                onAction={onQuickAction}
                onShowLogs={onShowLogs}
              />
            ) : null}
            {turn.runId && !turn.quickActions?.some((a) => a.id.startsWith('show_details_')) ? (
              <p className="chat-run-link">
                <Link to={`/runs/${encodeURIComponent(turn.runId)}`}>View run details →</Link>
              </p>
            ) : null}
          </>
        ) : (
          <div className="chat-bubble-body">{turn.content}</div>
        )}
      </div>
    </div>
  );
}

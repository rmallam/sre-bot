import type { ChatTurn } from '../api';
import { StreamingMessage } from './StreamingMessage';
import { ChatQuickActions, type ChatQuickAction } from './ChatQuickActions';

interface Props {
  turn: ChatTurn;
  animate?: boolean;
  onAnimationComplete?: () => void;
  onQuickAction?: () => void;
}

export function ChatMessageBubble({
  turn,
  animate = false,
  onAnimationComplete,
  onQuickAction,
}: Props) {
  const className =
    turn.role === 'user'
      ? 'chat-bubble chat-bubble-user'
      : turn.role === 'status'
        ? 'chat-bubble chat-bubble-status'
        : 'chat-bubble chat-bubble-assistant';

  return (
    <div className={className}>
      {turn.role === 'status' ? (
        <div className="chat-bubble-body chat-status-line">
          <span className="chat-status-dot" aria-hidden />
          <span className="chat-status-text">{turn.content}</span>
        </div>
      ) : turn.role === 'assistant' ? (
        <>
          <StreamingMessage
            content={turn.content}
            animate={animate}
            onComplete={onAnimationComplete}
          />
          {turn.quickActions?.length ? (
            <ChatQuickActions
              actions={turn.quickActions as ChatQuickAction[]}
              incidentId={turn.incidentId}
              onAction={onQuickAction}
            />
          ) : null}
        </>
      ) : (
        <div className="chat-bubble-body">{turn.content}</div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';

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

interface Props {
  content: string;
  /** When false, show full text immediately (history / already seen). */
  animate?: boolean;
  onComplete?: () => void;
}

/** Cursor-style typewriter reveal for assistant replies. */
export function StreamingMessage({ content, animate = true, onComplete }: Props) {
  const [visibleChars, setVisibleChars] = useState(animate ? 0 : content.length);
  const completedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (!animate) {
      setVisibleChars(content.length);
      return;
    }

    setVisibleChars(0);
    completedRef.current = false;

    let i = 0;
    const tick = () => {
      // Slightly faster for long messages so UX stays snappy.
      const step = content.length > 800 ? 4 : content.length > 300 ? 3 : 2;
      i = Math.min(content.length, i + step);
      setVisibleChars(i);
      if (i >= content.length && !completedRef.current) {
        completedRef.current = true;
        onCompleteRef.current?.();
      }
    };

    const id = window.setInterval(tick, 16);
    return () => window.clearInterval(id);
  }, [content, animate]);

  const slice = content.slice(0, visibleChars);
  const done = visibleChars >= content.length;

  return (
    <div className="chat-bubble-body chat-streaming">
      <span dangerouslySetInnerHTML={{ __html: formatContent(slice) }} />
      {animate && !done && <span className="chat-stream-cursor" aria-hidden />}
    </div>
  );
}

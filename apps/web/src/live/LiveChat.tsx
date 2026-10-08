import { useCallback, useEffect, useRef, useState } from 'react';
import { CHAT_MAX_LENGTH, type ChatMessageDto } from '@tesor_gp/shared';
import { ApiError, errorMessage } from '../api/client';
import { liveApi } from '../api/endpoints';

const POLL_MS = 3000;

interface Props {
  streamId: string;
  /** Poll for new messages (the stream is on air). */
  live: boolean;
  /** Why this person cannot write (not signed in, no access); null when they can. */
  postBlockedReason: string | null;
  /** The creator (or an admin) may remove messages. */
  canModerate?: boolean;
}

/**
 * Chat under a live stream. New messages are fetched every few seconds (simple polling works through the free hosting's
 * proxy, where long-lived connections do not).
 */
export function LiveChat({ streamId, live, postBlockedReason, canModerate = false }: Props): JSX.Element {
  const [messages, setMessages] = useState<ChatMessageDto[]>([]);
  const [open, setOpen] = useState(live);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastId = useRef<number | undefined>(undefined);
  const listRef = useRef<HTMLOListElement>(null);
  const stickToBottom = useRef(true);

  const merge = useCallback((items: ChatMessageDto[], removed: number[] = []) => {
    setMessages((prev) => {
      const gone = new Set(removed);
      const byId = new Map(prev.filter((m) => !gone.has(m.id)).map((m) => [m.id, m]));
      for (const m of items) if (!gone.has(m.id)) byId.set(m.id, m);
      return Array.from(byId.values()).sort((a, b) => a.id - b.id);
    });
    const newest = items[items.length - 1]?.id;
    if (newest !== undefined && (lastId.current === undefined || newest > lastId.current)) lastId.current = newest;
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    lastId.current = undefined;
    setMessages([]);
    const tick = async (): Promise<void> => {
      try {
        const res = await liveApi.chat(streamId, lastId.current);
        if (stopped) return;
        merge(res.items, res.removed);
        setOpen(res.open);
        if (!res.open) return; // the stream ended: the chat is complete
      } catch {
        // a missed poll is retried at the next tick
      }
      if (!stopped && live) timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [streamId, live, merge]);

  // Follow new messages unless the reader has scrolled up.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = async (): Promise<void> => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const m = await liveApi.postChat(streamId, body);
      merge([m]);
      setText('');
      stickToBottom.current = true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) setError('Slow down a little: a few messages every 10 seconds.');
      else if (err instanceof ApiError && err.code === 'PURCHASE_REQUIRED') setError('Get access to the stream to chat.');
      else if (err instanceof ApiError && err.code === 'CHAT_CLOSED') {
        setOpen(false);
        setError('The chat closed when the stream ended.');
      } else setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const remove = async (id: number): Promise<void> => {
    try {
      await liveApi.removeChat(streamId, id);
      merge([], [id]);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <section className="live-chat card" aria-label="Live chat" data-testid="live-chat">
      <h2>{open ? 'Live chat' : 'Chat replay'}</h2>
      <ol
        className="chat-list"
        ref={listRef}
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {messages.length === 0 ? <li className="muted small">{open ? 'No messages yet. Say hello!' : 'No messages.'}</li> : null}
        {messages.map((m) => (
          <li key={m.id} className={m.fromCreator ? 'from-creator' : ''} data-testid="chat-message">
            <strong>{m.user.username}</strong>
            {m.fromCreator ? <span className="badge small-badge">Creator</span> : null} <span className="chat-text">{m.text}</span>
            {canModerate ? (
              <button type="button" className="link-btn chat-remove" aria-label={`Remove message from ${m.user.username}`} onClick={() => void remove(m.id)}>
                ×
              </button>
            ) : null}
          </li>
        ))}
      </ol>
      {open ? (
        postBlockedReason ? (
          <p className="muted small">{postBlockedReason}</p>
        ) : (
          <form
            className="chat-form"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <label className="sr-only" htmlFor={`chat-${streamId}`}>
              Message
            </label>
            <input id={`chat-${streamId}`} value={text} onChange={(e) => setText(e.target.value)} maxLength={CHAT_MAX_LENGTH} placeholder="Say something…" autoComplete="off" />
            <button type="submit" className="btn primary" disabled={sending || !text.trim()}>
              Send
            </button>
          </form>
        )
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

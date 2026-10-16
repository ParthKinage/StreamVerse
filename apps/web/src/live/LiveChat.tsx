import { useCallback, useEffect, useRef, useState } from 'react';
import { CHAT_MAX_LENGTH, MAX_TIP_STRM, MIN_TIP_STRM, TIP_PRESETS_STRM, parseSTRM, weiToString, type ChatMessageDto } from '@tesor_gp/shared';
import { money } from '../lib/format';
import { ApiError, errorMessage } from '../api/client';
import { liveApi } from '../api/endpoints';
import { ReportDialog } from '../components/ReportDialog';

const POLL_MS = 3000;

interface Props {
  streamId: string;
  /** Poll for new messages (the stream is on air). */
  live: boolean;
  /** Why this person cannot write (not signed in, no access); null when they can. */
  postBlockedReason: string | null;
  /** The creator (or an admin) may remove messages. */
  canModerate?: boolean;
  /** Signed-in viewers may report messages from others. */
  canReport?: boolean;
  /** The signed-in viewer's id, so their own messages have no Report button. */
  myId?: string;
  /** Show the tip bar (viewers with access; never the creator). */
  canTip?: boolean;
  /** Called after a tip went through, with the viewer's new balance. */
  onTipped?(availableWei: string): void;
  /** Called when a tip needs more money than the viewer has. */
  onNeedMoney?(): void;
}

/**
 * Chat under a live stream. New messages are fetched every few seconds (simple polling works through the free hosting's
 * proxy, where long-lived connections do not).
 */
export function LiveChat({ streamId, live, postBlockedReason, canModerate = false, canReport = false, myId, canTip = false, onTipped, onNeedMoney }: Props): JSX.Element {
  const [reportingId, setReportingId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessageDto[]>([]);
  const [open, setOpen] = useState(live);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tip, setTip] = useState<string>(String(TIP_PRESETS_STRM[0]));
  const [otherTip, setOtherTip] = useState(false);
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

  /** Sends a tip; whatever is typed in the message box goes with it. */
  const sendTip = async (): Promise<void> => {
    const amount = tip.trim();
    if (sending) return;
    if (!/^\d+(\.\d{1,18})?$/.test(amount) || Number(amount) < MIN_TIP_STRM || Number(amount) > MAX_TIP_STRM) {
      setError(`Enter a tip between ${MIN_TIP_STRM} and ${MAX_TIP_STRM}.`);
      return;
    }
    setSending(true);
    setError(null);
    try {
      const body = text.trim();
      const res = await liveApi.tip(streamId, weiToString(parseSTRM(amount)), body || undefined);
      merge([res.message]);
      setText('');
      stickToBottom.current = true;
      onTipped?.(res.availableWei);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INSUFFICIENT_BALANCE') {
        setError('Your balance is too low for this tip.');
        onNeedMoney?.();
      } else if (err instanceof ApiError && err.status === 429) setError('That’s a lot of tips. Try again in a minute.');
      else if (err instanceof ApiError && err.code === 'LIVE_NOT_ACTIVE') {
        setOpen(false);
        setError('Tips close when the stream ends.');
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
          <li key={m.id} className={[m.fromCreator ? 'from-creator' : '', m.tipWei ? 'chat-tip' : ''].join(' ').trim()} data-testid="chat-message">
            <strong>{m.user.username}</strong>
            {m.fromCreator ? <span className="badge small-badge">Creator</span> : null}
            {m.tipWei ? <span className="tip-amount" data-testid="chat-tip">tipped {money(m.tipWei)}</span> : null}{' '}
            {m.text ? <span className="chat-text">{m.tipWei ? `“${m.text}”` : m.text}</span> : null}
            {canModerate ? (
              <button type="button" className="link-btn chat-remove" aria-label={`Remove message from ${m.user.username}`} onClick={() => void remove(m.id)}>
                ×
              </button>
            ) : canReport && m.user.id !== myId ? (
              <button type="button" className="link-btn chat-remove" aria-label={`Report message from ${m.user.username}`} onClick={() => setReportingId(m.id)}>
                Report
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
      {open && !postBlockedReason && canTip ? (
        <div className="tip-bar" role="group" aria-label="Send a tip">
          <span className="tip-label">Tip</span>
          {TIP_PRESETS_STRM.map((n) => (
            <button
              key={n}
              type="button"
              className={!otherTip && tip === String(n) ? 'tip-choice active' : 'tip-choice'}
              aria-pressed={!otherTip && tip === String(n)}
              onClick={() => {
                setOtherTip(false);
                setTip(String(n));
              }}
            >
              {n}
            </button>
          ))}
          {otherTip ? (
            <input className="tip-other" aria-label="Tip amount" inputMode="decimal" value={tip} onChange={(e) => setTip(e.target.value)} autoFocus />
          ) : (
            <button
              type="button"
              className="tip-choice"
              onClick={() => {
                setOtherTip(true);
                setTip('');
              }}
            >
              Other
            </button>
          )}
          <button type="button" className="btn primary" disabled={sending} onClick={() => void sendTip()} data-testid="send-tip">
            Send tip
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {reportingId !== null ? <ReportDialog targetType="CHAT_MESSAGE" targetId={String(reportingId)} onClose={() => setReportingId(null)} /> : null}
    </section>
  );
}

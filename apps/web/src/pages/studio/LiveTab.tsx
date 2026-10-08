import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DEFAULT_LIVE_PRICE_STRM, MAX_ACCESS_PRICE_STRM, parseSTRM, weiToString, type LiveStreamDto } from '@tesor_gp/shared';
import { errorMessage } from '../../api/client';
import { liveApi } from '../../api/endpoints';
import { keys, useConfig } from '../../api/queries';
import { Field } from '../../components/Field';
import { ErrorState, Skeleton } from '../../components/States';
import { useToast } from '../../components/Toasts';
import { formatDuration, money, moneyUnit, timeAgo } from '../../lib/format';
import { canComposite } from '../../live/compositor';
import { LiveChat } from '../../live/LiveChat';
import { canStreamFromBrowser } from '../../live/sender';
import { isSending, liveSession, useLiveSession, type Source } from '../../live/session';
import { VideoFields, validateVideoForm, type VideoFormValues } from './VideoForm';

const liveKey = ['creator', 'live'] as const;
const ACTIVE = new Set(['CREATED', 'STARTING', 'LIVE', 'ENDING']);

const STATUS_TEXT: Record<string, string> = {
  CREATED: 'Ready',
  STARTING: 'Connecting',
  LIVE: 'Live',
  ENDING: 'Ending',
  ENDED: 'Ended',
  FAILED: 'Not started',
};

export function validatePrice(raw: string): { error?: string; wei?: string } {
  const price = raw.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(price)) return { error: 'Enter a price like 50 (or 0 for free)' };
  const wei = parseSTRM(price);
  if (wei > parseSTRM(String(MAX_ACCESS_PRICE_STRM))) return { error: `The price can be at most ${MAX_ACCESS_PRICE_STRM}` };
  return { wei: weiToString(wei) };
}

function SetupForm({ onCreated }: { onCreated(): void }): JSX.Element {
  const { data: config } = useConfig();
  const toast = useToast();
  // The rate field of the shared form does not apply to streams; the price below replaces it.
  const [values, setValues] = useState<VideoFormValues>({ title: '', description: '', category: 'General', tags: '', rate: '0' });
  const [price, setPrice] = useState(DEFAULT_LIVE_PRICE_STRM);
  const [save, setSave] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  return (
    <form
      className="form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const v = validateVideoForm(values);
        const p = validatePrice(price);
        const all = { ...v.errors, ...(p.error ? { price: p.error } : {}) };
        setErrors(all);
        if (Object.keys(all).length || p.wei === undefined) return;
        setPending(true);
        setServerError(null);
        liveApi
          .create({ title: values.title.trim(), description: values.description.trim(), category: values.category, tags: v.tags ?? [], saveAsVod: save, priceWei: p.wei })
          .then(() => {
            toast.success('Your stream is set up. Choose what to show, then go live.');
            onCreated();
          })
          .catch((err) => setServerError(errorMessage(err)))
          .finally(() => setPending(false));
      }}
    >
      <h2>Set up a live stream</h2>
      <VideoFields values={values} onChange={setValues} errors={errors} categories={config?.categories ?? ['General']} hideRate>
        <Field
          label={`Price to watch (${moneyUnit()})`}
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          error={errors.price}
          hint={`Viewers pay this once and can watch the stream, and its recording, as often as they like. 0 makes it free. Maximum ${MAX_ACCESS_PRICE_STRM}.`}
        />
        <label className="check">
          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Keep the recording as a video when the stream ends
        </label>
      </VideoFields>
      {serverError ? (
        <p className="form-error" role="alert">
          {serverError}
        </p>
      ) : null}
      <button type="submit" className="btn primary" disabled={pending}>
        {pending ? 'Setting up…' : 'Set up stream'}
      </button>
    </form>
  );
}

function ObsHelp(): JSX.Element {
  return (
    <details className="card obs-help">
      <summary>Using OBS</summary>
      <ol>
        <li>Set up your scenes in OBS as usual, then press <strong>Start Virtual Camera</strong> (in the Controls panel).</li>
        <li>
          Here, choose <strong>Camera</strong> and pick <strong>OBS Virtual Camera</strong>.
        </li>
        <li>
          The virtual camera carries the picture only. For your microphone, pick it below. For game sound, music or alerts, install a free virtual audio
          cable (for example VB-Audio Virtual Cable), set it as the <em>Monitoring Device</em> in OBS (Settings, Audio, Advanced), turn on monitoring for
          those sources, and pick the cable as the microphone here.
        </li>
        <li>Without OBS, choose <strong>Screen with camera</strong> to show your screen with your camera in the corner.</li>
        <li>Viewers are about 10 to 20 seconds behind. You can switch tabs or use other apps; keep this page open until you end the stream.</li>
      </ol>
    </details>
  );
}

function StreamControl({ stream }: { stream: LiveStreamDto }): JSX.Element {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useLiveSession();
  const [source, setSource] = useState<Source>(session.streamId === stream.id ? session.source : 'camera');
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState('');
  const [micId, setMicId] = useState('');
  const [ending, setEnding] = useState(false);
  const mine = session.streamId === stream.id;
  const status = mine ? session.status : null;
  const sending = mine && isSending(session);
  const hasMedia = mine && session.hasMedia;
  const supported = canStreamFromBrowser();

  const stats = useQuery({ queryKey: [...liveKey, stream.id], queryFn: () => liveApi.get(stream.id), initialData: stream, refetchInterval: 5000 });
  const s = stats.data;
  const phase = status?.phase;
  const refetchStats = stats.refetch;
  // Show the new state at once when the sender connects or stops, rather than at the next poll.
  useEffect(() => {
    if (phase) void refetchStats();
  }, [phase, refetchStats]);

  // The preview element changes with the source (a canvas for the mixed picture); the session keeps the media itself.
  // React calls this with null when the element goes away, so leaving the page detaches it without stopping anything.
  const previewRef = useCallback((el: HTMLVideoElement | HTMLCanvasElement | null) => liveSession.attachPreview(el), []);

  const listDevices = useCallback(async () => {
    const all = await navigator.mediaDevices.enumerateDevices();
    setCameras(all.filter((d) => d.kind === 'videoinput'));
    setMics(all.filter((d) => d.kind === 'audioinput'));
  }, []);

  const acquire = async (): Promise<void> => {
    await liveSession.acquire(stream.id, source, { cameraId, micId });
    await listDevices();
  };

  const end = async (): Promise<void> => {
    setEnding(true);
    try {
      if (mine) await liveSession.stopSending();
      await liveApi.end(stream.id);
      if (mine) liveSession.release();
      toast.success(stream.saveAsVod ? 'Stream ended. The recording is now in your videos.' : 'Stream ended.');
      await qc.invalidateQueries({ queryKey: liveKey });
      await qc.invalidateQueries({ queryKey: keys.creatorVideos });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setEnding(false);
    }
  };

  const onAir = s.status === 'LIVE';
  const mixed = (mine ? session.source : source) === 'both';
  return (
    <section className="live-control" aria-label="Live stream">
      <div className="live-head">
        <h2>{s.title}</h2>
        <span className={`badge ${onAir ? 'live' : ''}`} data-testid="live-status">
          {STATUS_TEXT[s.status] ?? s.status}
        </span>
      </div>
      <p className="muted">
        {toPriceText(s.priceWei)} · {s.saveAsVod ? 'the recording will be kept as a video' : 'the recording will not be kept'} ·{' '}
        <Link to={`/watch/${s.videoId}`} target="_blank" rel="noreferrer">
          Viewer page
        </Link>
      </p>
      <dl className="stats">
        <div>
          <dt>Watching now</dt>
          <dd data-testid="live-viewers">{s.viewers}</dd>
        </div>
        <div>
          <dt>Peak</dt>
          <dd>{s.peakViewers}</dd>
        </div>
        <div>
          <dt>Bought access</dt>
          <dd data-testid="live-buyers">{s.buyers}</dd>
        </div>
        <div>
          <dt>Streamed</dt>
          <dd>{formatDuration(s.durationSeconds)}</dd>
        </div>
        <div>
          <dt>Earned</dt>
          <dd data-testid="live-earned">{money(s.earnedWei)}</dd>
        </div>
      </dl>

      {!supported ? (
        <p className="notice" role="alert">
          This browser cannot go live. Use a recent Chrome or Edge on a computer.
        </p>
      ) : (
        <div className="live-layout">
          <div className="live-main">
            {mixed ? (
              <canvas ref={previewRef} className="live-preview" aria-label="Preview of what viewers see" />
            ) : (
              <video ref={previewRef} className="live-preview" muted autoPlay playsInline aria-label="Preview of what viewers see" />
            )}
            <fieldset className="live-source" disabled={sending}>
              <legend>What to stream</legend>
              <label className="check">
                <input type="radio" name="live-source" checked={source === 'camera'} onChange={() => setSource('camera')} /> Camera (or OBS Virtual Camera)
              </label>
              <label className="check">
                <input type="radio" name="live-source" checked={source === 'screen'} onChange={() => setSource('screen')} /> Screen or window
              </label>
              <label className="check">
                <input type="radio" name="live-source" checked={source === 'both'} disabled={!canComposite()} onChange={() => setSource('both')} data-testid="source-both" /> Screen with
                camera in the corner
              </label>
              {source !== 'screen' && cameras.length ? (
                <div className="field">
                  <label htmlFor="live-camera">Camera</label>
                  <select id="live-camera" value={cameraId} onChange={(e) => setCameraId(e.target.value)}>
                    <option value="">Default camera</option>
                    {cameras.map((c, i) => (
                      <option key={c.deviceId || i} value={c.deviceId}>
                        {c.label || `Camera ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              {mics.length ? (
                <div className="field">
                  <label htmlFor="live-mic">Microphone</label>
                  <select id="live-mic" value={micId} onChange={(e) => setMicId(e.target.value)}>
                    <option value="">Default microphone</option>
                    {mics.map((m, i) => (
                      <option key={m.deviceId || i} value={m.deviceId}>
                        {m.label || `Microphone ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <button type="button" className="btn" onClick={() => void acquire()} data-testid="live-preview">
                {hasMedia ? 'Apply' : source === 'camera' ? 'Turn on camera' : 'Choose screen'}
              </button>
            </fieldset>
            {mine && session.mediaError ? (
              <p className="form-error" role="alert">
                {session.mediaError}
              </p>
            ) : null}
            {status ? (
              <p className={status.phase === 'error' ? 'form-error' : 'muted'} role="status" data-testid="sender-status">
                {status.phase === 'connecting'
                  ? 'Connecting…'
                  : status.phase === 'live'
                    ? `You are live · ${status.sent} ${status.sent === 1 ? 'piece' : 'pieces'} sent · you can switch tabs, the stream keeps going`
                    : status.phase === 'stopping'
                      ? 'Sending the last seconds…'
                      : status.phase === 'error'
                        ? status.message
                        : 'Stopped'}
                {status.phase !== 'error' && status.message ? ` · ${status.message}` : ''}
              </p>
            ) : onAir ? (
              <p className="notice">You were live from another tab or before a reload. Choose what to stream and press Carry on streaming.</p>
            ) : null}
            <div className="actions">
              {!sending ? (
                <button type="button" className="btn primary" disabled={!hasMedia} onClick={() => void liveSession.goLive()} data-testid="go-live">
                  {onAir ? 'Carry on streaming' : 'Go live'}
                </button>
              ) : null}
              <button type="button" className="btn danger" disabled={ending} onClick={() => void end()} data-testid="end-live">
                {ending ? 'Ending…' : s.status === 'CREATED' ? 'Cancel stream' : 'End stream'}
              </button>
            </div>
            <ObsHelp />
          </div>
          {s.status !== 'CREATED' ? <LiveChat streamId={s.id} live={s.status === 'LIVE' || s.status === 'STARTING'} postBlockedReason={null} canModerate /> : null}
        </div>
      )}
    </section>
  );
}

function toPriceText(priceWei: string): string {
  return BigInt(priceWei || '0') === 0n ? 'Free to watch' : `${money(priceWei)} to watch, once`;
}

export function LiveTab(): JSX.Element {
  const qc = useQueryClient();
  const session = useLiveSession();
  const q = useQuery({ queryKey: liveKey, queryFn: liveApi.mine });
  const active = q.data?.items.find((s) => ACTIVE.has(s.status));
  // A stream that ended elsewhere (an admin, or the idle timeout) releases the camera and screen.
  useEffect(() => {
    if (q.data && session.streamId && session.streamId !== active?.id && !isSending(session)) liveSession.release();
  }, [q.data, session, active?.id]);
  if (q.isPending) return <Skeleton className="thumb" />;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const past = q.data.items.filter((s) => !ACTIVE.has(s.status));
  return (
    <div className="live-tab">
      {active ? <StreamControl key={active.id} stream={active} /> : <SetupForm onCreated={() => void qc.invalidateQueries({ queryKey: liveKey })} />}
      {past.length ? (
        <section aria-label="Past streams">
          <h2>Past streams</h2>
          <ul className="plain-list">
            {past.map((s) => (
              <li key={s.id}>
                <strong>{s.title}</strong> · {STATUS_TEXT[s.status]} · {formatDuration(s.durationSeconds)} · {s.buyers} bought access · earned {money(s.earnedWei)} · peak{' '}
                {s.peakViewers} watching · {timeAgo(s.endedAt ?? s.createdAt)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

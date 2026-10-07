import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { DEFAULT_RATE_PER_MINUTE_STRM, type LiveStreamDto } from '@tesor_gp/shared';
import { errorMessage } from '../../api/client';
import { liveApi } from '../../api/endpoints';
import { keys, useConfig } from '../../api/queries';
import { ErrorState, Skeleton } from '../../components/States';
import { useToast } from '../../components/Toasts';
import { formatDuration, money, rateLabel, timeAgo } from '../../lib/format';
import { BrowserCannotStream, LiveSender, canStreamFromBrowser, type SenderStatus } from '../../live/sender';
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

function SetupForm({ onCreated }: { onCreated(): void }): JSX.Element {
  const { data: config } = useConfig();
  const toast = useToast();
  const [values, setValues] = useState<VideoFormValues>({ title: '', description: '', category: 'General', tags: '', rate: DEFAULT_RATE_PER_MINUTE_STRM });
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
        const v = validateVideoForm(values, config ? Number(BigInt(config.maxRatePerMinuteWei) / 10n ** 18n) : undefined);
        setErrors(v.errors);
        if (Object.keys(v.errors).length) return;
        setPending(true);
        setServerError(null);
        liveApi
          .create({
            title: values.title.trim(),
            description: values.description.trim(),
            category: values.category,
            tags: v.tags ?? [],
            saveAsVod: save,
            ...(v.rateWei !== undefined ? { ratePerMinuteWei: v.rateWei } : {}),
          })
          .then(() => {
            toast.success('Your stream is set up. Choose a camera or screen, then go live.');
            onCreated();
          })
          .catch((err) => setServerError(errorMessage(err)))
          .finally(() => setPending(false));
      }}
    >
      <h2>Set up a live stream</h2>
      <VideoFields values={values} onChange={setValues} errors={errors} categories={config?.categories ?? ['General']}>
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
        <li>Keep this tab open while you are live. Viewers are about 10 to 20 seconds behind.</li>
      </ol>
    </details>
  );
}

type Source = 'camera' | 'screen';

function StreamControl({ stream }: { stream: LiveStreamDto }): JSX.Element {
  const qc = useQueryClient();
  const toast = useToast();
  const previewRef = useRef<HTMLVideoElement>(null);
  const mediaRef = useRef<MediaStream | null>(null);
  const senderRef = useRef<LiveSender | null>(null);
  const [source, setSource] = useState<Source>('camera');
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState('');
  const [micId, setMicId] = useState('');
  const [hasMedia, setHasMedia] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [status, setStatus] = useState<SenderStatus | null>(null);
  const [ending, setEnding] = useState(false);
  const sending = status?.phase === 'connecting' || status?.phase === 'live' || status?.phase === 'stopping';
  const supported = canStreamFromBrowser();

  const stats = useQuery({ queryKey: [...liveKey, stream.id], queryFn: () => liveApi.get(stream.id), initialData: stream, refetchInterval: 5000 });
  const s = stats.data;
  const phase = status?.phase;
  const refetchStats = stats.refetch;
  // Show the new state at once when the sender connects or stops, rather than at the next poll.
  useEffect(() => {
    if (phase) void refetchStats();
  }, [phase, refetchStats]);

  const stopMedia = (): void => {
    mediaRef.current?.getTracks().forEach((t) => t.stop());
    mediaRef.current = null;
    setHasMedia(false);
  };

  const listDevices = useCallback(async () => {
    const all = await navigator.mediaDevices.enumerateDevices();
    setCameras(all.filter((d) => d.kind === 'videoinput'));
    setMics(all.filter((d) => d.kind === 'audioinput'));
  }, []);

  const acquire = useCallback(async () => {
    setMediaError(null);
    try {
      const mic = micId ? { deviceId: { exact: micId } } : true;
      let media: MediaStream;
      if (source === 'screen') {
        const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
        const voice = await navigator.mediaDevices.getUserMedia({ audio: mic }).catch(() => null);
        // One audio track goes out: the microphone if there is one, otherwise the shared tab's sound.
        const audio = voice?.getAudioTracks()[0] ?? screen.getAudioTracks()[0];
        media = new MediaStream([...screen.getVideoTracks(), ...(audio ? [audio] : [])]);
      } else {
        media = await navigator.mediaDevices.getUserMedia({
          video: { ...(cameraId ? { deviceId: { exact: cameraId } } : {}), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
          audio: mic,
        });
      }
      mediaRef.current?.getTracks().forEach((t) => t.stop());
      mediaRef.current = media;
      if (previewRef.current) previewRef.current.srcObject = media;
      setHasMedia(true);
      await listDevices();
    } catch (err) {
      const name = (err as Error).name;
      setMediaError(name === 'NotAllowedError' ? 'Allow access to your camera and microphone (or screen) to go live.' : `Could not open the ${source}: ${(err as Error).message}`);
    }
  }, [cameraId, micId, source, listDevices]);

  // Closing the page while live would leave viewers hanging until the stream times out: ask first.
  useEffect(() => {
    if (!sending) return undefined;
    const warn = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [sending]);

  useEffect(
    () => () => {
      void senderRef.current?.stop();
      mediaRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const goLive = async (): Promise<void> => {
    const media = mediaRef.current;
    if (!media) return;
    const sender = new LiveSender(stream.id, media, liveApi, setStatus, () => previewRef.current);
    senderRef.current = sender;
    setStatus({ phase: 'connecting', sent: 0, waiting: 0, dropped: 0 });
    try {
      await sender.start();
    } catch (err) {
      setStatus({ phase: 'error', sent: 0, waiting: 0, dropped: 0, message: err instanceof BrowserCannotStream ? err.message : errorMessage(err) });
    }
  };

  const end = async (): Promise<void> => {
    setEnding(true);
    try {
      await senderRef.current?.stop();
      senderRef.current = null;
      await liveApi.end(stream.id);
      stopMedia();
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
  return (
    <section className="live-control" aria-label="Live stream">
      <div className="live-head">
        <h2>{s.title}</h2>
        <span className={`badge ${onAir ? 'live' : ''}`} data-testid="live-status">
          {STATUS_TEXT[s.status] ?? s.status}
        </span>
      </div>
      <p className="muted">
        {rateLabel(s.ratePerMinuteWei)} · {s.saveAsVod ? 'the recording will be kept as a video' : 'the recording will not be kept'} ·{' '}
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
        <>
          <video ref={previewRef} className="live-preview" muted autoPlay playsInline aria-label="Preview of what viewers see" />
          <fieldset className="live-source" disabled={sending}>
            <legend>What to stream</legend>
            <label className="check">
              <input type="radio" name="live-source" checked={source === 'camera'} onChange={() => setSource('camera')} /> Camera (or OBS Virtual Camera)
            </label>
            <label className="check">
              <input type="radio" name="live-source" checked={source === 'screen'} onChange={() => setSource('screen')} /> Screen or window
            </label>
            {source === 'camera' && cameras.length ? (
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
              {hasMedia ? 'Apply' : source === 'screen' ? 'Choose screen' : 'Turn on camera'}
            </button>
          </fieldset>
          {mediaError ? (
            <p className="form-error" role="alert">
              {mediaError}
            </p>
          ) : null}
          {status ? (
            <p className={status.phase === 'error' ? 'form-error' : 'muted'} role="status" data-testid="sender-status">
              {status.phase === 'connecting' ? 'Connecting…' : status.phase === 'live' ? `You are live · ${status.sent} ${status.sent === 1 ? 'piece' : 'pieces'} sent` : status.phase === 'stopping' ? 'Sending the last seconds…' : status.phase === 'error' ? status.message : 'Stopped'}
              {status.phase !== 'error' && status.message ? ` · ${status.message}` : ''}
            </p>
          ) : onAir ? (
            <p className="notice">You were live from another tab or before a reload. Choose your camera or screen and press Go live to carry on.</p>
          ) : null}
          <div className="actions">
            {!sending ? (
              <button type="button" className="btn primary" disabled={!hasMedia} onClick={() => void goLive()} data-testid="go-live">
                {onAir ? 'Carry on streaming' : 'Go live'}
              </button>
            ) : null}
            <button type="button" className="btn danger" disabled={ending} onClick={() => void end()} data-testid="end-live">
              {ending ? 'Ending…' : s.status === 'CREATED' ? 'Cancel stream' : 'End stream'}
            </button>
          </div>
          <ObsHelp />
        </>
      )}
    </section>
  );
}

export function LiveTab(): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: liveKey, queryFn: liveApi.mine });
  if (q.isPending) return <Skeleton className="thumb" />;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const active = q.data.items.find((s) => ACTIVE.has(s.status));
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
                <strong>{s.title}</strong> · {STATUS_TEXT[s.status]} · {formatDuration(s.durationSeconds)} · earned {money(s.earnedWei)} · peak {s.peakViewers} watching ·{' '}
                {timeAgo(s.endedAt ?? s.createdAt)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

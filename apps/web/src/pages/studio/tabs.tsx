import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { ALLOWED_UPLOAD_MIME, DEFAULT_RATE_PER_MINUTE_STRM, type VideoDto } from '@tesor_gp/shared';
import { ApiError, errorMessage } from '../../api/client';
import { creatorApi } from '../../api/endpoints';
import { keys, useConfig } from '../../api/queries';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Modal } from '../../components/Modal';
import { EmptyState, ErrorState, Skeleton } from '../../components/States';
import { useToast } from '../../components/Toasts';
import { formatDuration, money, moneyTitle, timeAgo, costLabel } from '../../lib/format';
import { VideoFields, validateVideoForm, weiToPriceInput, type VideoFormValues } from './VideoForm';

const ALLOWED_EXT = ['.mp4', '.mov', '.mkv', '.webm', '.avi'];

export function checkFile(file: File, maxMb: number): string | null {
  const name = file.name.toLowerCase();
  if (!ALLOWED_EXT.some((e) => name.endsWith(e)) || !(ALLOWED_UPLOAD_MIME as readonly string[]).includes(file.type)) return 'Choose an MP4, MOV, MKV, WebM or AVI video file.';
  if (file.size === 0) return 'That file is empty.';
  if (file.size > maxMb * 1024 * 1024) return `That file is larger than the ${maxMb} MB limit.`;
  return null;
}

/** Grabs a frame from the chosen file in the browser, only for the preview. */
function useThumbnailPreview(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'metadata';
    v.src = objectUrl;
    const draw = (): void => {
      try {
        const c = document.createElement('canvas');
        c.width = 320;
        c.height = Math.max(1, Math.round((320 * (v.videoHeight || 9)) / (v.videoWidth || 16)));
        c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
        setUrl(c.toDataURL('image/jpeg', 0.7));
      } catch {
        setUrl(null);
      }
    };
    v.onloadedmetadata = () => {
      v.currentTime = Math.min(1, (v.duration || 2) / 10);
    };
    v.onseeked = draw;
    return () => {
      URL.revokeObjectURL(objectUrl);
      v.onloadedmetadata = null;
      v.onseeked = null;
    };
  }, [file]);
  return url;
}

export function UploadTab({ onUploaded }: { onUploaded(): void }): JSX.Element {
  const { data: config } = useConfig();
  const qc = useQueryClient();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [values, setValues] = useState<VideoFormValues>({ title: '', description: '', category: 'General', tags: '', rate: DEFAULT_RATE_PER_MINUTE_STRM });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<number | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const preview = useThumbnailPreview(file);
  const maxMb = config?.maxUploadMb ?? 1024;

  const pick = (f: File | undefined): void => {
    if (!f) return;
    const problem = checkFile(f, maxMb);
    setFileError(problem);
    if (problem) return setFile(null);
    setFile(f);
    if (!values.title) setValues((v) => ({ ...v, title: f.name.replace(/\.[^.]+$/, '') }));
  };
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files[0]);
  };

  const submit = async (): Promise<void> => {
    if (!file) return setFileError('Choose a video file first.');
    const v = validateVideoForm(values, config ? Number(BigInt(config.maxRatePerMinuteWei) / 10n ** 18n) : undefined);
    setErrors(v.errors);
    if (Object.keys(v.errors).length) return;
    const fields: Record<string, string> = {
      title: values.title.trim(),
      description: values.description.trim(),
      category: values.category,
      tags: (v.tags ?? []).join(','),
      ...(v.rateWei !== undefined ? { ratePerMinuteWei: v.rateWei } : {}),
    };
    const ctl = new AbortController();
    abortRef.current = ctl;
    setProgress(0);
    setServerError(null);
    try {
      if (config?.uploadMode === 'direct') {
        await creatorApi.directUpload(file, fields, setProgress, ctl.signal);
      } else {
        const form = new FormData();
        for (const [k, val] of Object.entries(fields)) form.set(k, val);
        form.set('file', file);
        await creatorApi.upload(form, setProgress, ctl.signal);
      }
      await qc.invalidateQueries({ queryKey: keys.creatorVideos });
      toast.success('Upload complete. Transcoding has started.');
      onUploaded();
    } catch (err) {
      if ((err as Error).name === 'AbortError') toast.info('Upload cancelled');
      else setServerError(errorMessage(err));
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  };

  const uploading = progress !== null;
  return (
    <form
      className="form upload"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div
        className={`dropzone ${dragging ? 'drag' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p>{file ? file.name : 'Drag and drop a video here'}</p>
        <p className="muted small">MP4, MOV, MKV, WebM or AVI, up to {maxMb} MB</p>
        <button type="button" className="btn" onClick={() => inputRef.current?.click()} disabled={uploading}>
          {file ? 'Choose a different file' : 'Choose file'}
        </button>
        <input ref={inputRef} type="file" accept={ALLOWED_EXT.join(',') + ',video/*'} className="sr-only" aria-label="Video file" onChange={(e) => pick(e.target.files?.[0])} tabIndex={-1} />
      </div>
      {fileError ? (
        <p className="form-error" role="alert">
          {fileError}
        </p>
      ) : null}
      {preview ? <img className="preview" src={preview} alt="Thumbnail preview" /> : null}

      <VideoFields values={values} onChange={setValues} errors={errors} categories={config?.categories ?? ['General']} />

      {uploading ? (
        <div>
          <progress value={Math.round((progress ?? 0) * 100)} max={100} aria-label="Upload progress" />
          <span className="muted small"> {Math.round((progress ?? 0) * 100)}%</span>
        </div>
      ) : null}
      {serverError ? (
        <p className="form-error" role="alert">
          {serverError}
        </p>
      ) : null}
      <div className="actions">
        <button type="submit" className="btn primary" disabled={uploading || !file}>
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
        {uploading ? (
          <button type="button" className="btn" onClick={() => abortRef.current?.abort()}>
            Cancel upload
          </button>
        ) : null}
      </div>
    </form>
  );
}

function StatusBadge({ video }: { video: VideoDto }): JSX.Element {
  if (video.processingStatus === 'FAILED') return <span className="badge danger">Failed</span>;
  if (video.processingStatus === 'COMPLETED') return video.isPublished ? <span className="badge ok">Published</span> : <span className="badge">Draft</span>;
  return <span className="badge warn">{video.processingStatus === 'PENDING' ? 'Queued' : `Processing ${video.transcodeProgress}%`}</span>;
}

function EditDialog({ video, onClose }: { video: VideoDto; onClose(): void }): JSX.Element {
  const { data: config } = useConfig();
  const qc = useQueryClient();
  const toast = useToast();
  const [values, setValues] = useState<VideoFormValues>({
    title: video.title,
    description: video.description,
    category: video.category,
    tags: video.tags.join(', '),
    rate: weiToPriceInput(video.ratePerMinuteWei),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    const v = validateVideoForm(values);
    setErrors(v.errors);
    if (Object.keys(v.errors).length) return;
    setPending(true);
    setServerError(null);
    try {
      await creatorApi.update(video.id, { title: values.title.trim(), description: values.description.trim(), category: values.category, tags: v.tags ?? [], ...(v.rateWei !== undefined ? { ratePerMinuteWei: v.rateWei } : {}) });
      await qc.invalidateQueries({ queryKey: keys.creatorVideos });
      toast.success('Video updated');
      onClose();
    } catch (err) {
      setServerError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal title="Edit video" onClose={onClose} locked={pending}>
      <form
        className="form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <VideoFields values={values} onChange={setValues} errors={errors} categories={config?.categories ?? [video.category]} />
        {serverError ? (
          <p className="form-error" role="alert">
            {serverError}
          </p>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function VideosTab({ onUpload }: { onUpload(): void }): JSX.Element {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<VideoDto | null>(null);
  const [deleting, setDeleting] = useState<VideoDto | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const q = useInfiniteQuery({
    queryKey: keys.creatorVideos,
    queryFn: ({ pageParam }) => creatorApi.videos(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (l) => l.nextCursor ?? undefined,
    // Transcoding status is polled every 3 s while anything is still processing.
    refetchInterval: (query) => (query.state.data?.pages.some((p) => p.items.some((v) => v.processingStatus === 'PENDING' || v.processingStatus === 'PROCESSING')) ? 3000 : false),
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  const act = async (id: string, fn: () => Promise<unknown>, ok: string): Promise<void> => {
    setBusyId(id);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: keys.creatorVideos });
      toast.success(ok);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  if (q.isPending) return <Skeleton className="block" />;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  if (items.length === 0) {
    return (
      <EmptyState
        title="No videos yet"
        action={
          <button type="button" className="btn primary" onClick={onUpload}>
            Upload your first video
          </button>
        }
      >
        Upload a video and we will prepare it for streaming.
      </EmptyState>
    );
  }

  return (
    <>
      <table className="table studio-table">
        <thead>
          <tr>
            <th>Video</th>
            <th>Status</th>
            <th className="num">Rate</th>
            <th>Uploaded</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((v) => (
            <tr key={v.id} data-testid="studio-row">
              <td>
                <strong>{v.title}</strong>
                {v.durationSeconds ? <span className="muted small"> · {formatDuration(v.durationSeconds)}</span> : null}
                {v.processingStatus === 'FAILED' && v.failureReason ? (
                  <p className="form-error small" role="alert">
                    {v.failureReason}
                  </p>
                ) : null}
              </td>
              <td>
                <StatusBadge video={v} />
                {v.processingStatus === 'PROCESSING' ? <progress value={v.transcodeProgress} max={100} aria-label={`Transcoding ${v.title}`} /> : null}
              </td>
              <td className="num" title={moneyTitle(v.ratePerMinuteWei)}>
                {costLabel(v)}
              </td>
              <td>{timeAgo(v.createdAt)}</td>
              <td className="row-actions">
                {v.processingStatus === 'COMPLETED' ? (
                  <button type="button" className="btn small" disabled={busyId === v.id} onClick={() => void act(v.id, () => (v.isPublished ? creatorApi.unpublish(v.id) : creatorApi.publish(v.id)), v.isPublished ? 'Video unpublished' : 'Video published')}>
                    {v.isPublished ? 'Unpublish' : 'Publish'}
                  </button>
                ) : null}
                {v.processingStatus === 'FAILED' ? (
                  <button type="button" className="btn small" disabled={busyId === v.id} onClick={() => void act(v.id, () => creatorApi.retry(v.id), 'Transcoding restarted')}>
                    Retry
                  </button>
                ) : null}
                <button type="button" className="btn small" onClick={() => setEditing(v)}>
                  Edit
                </button>
                <button type="button" className="btn small danger" onClick={() => setDeleting(v)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {q.hasNextPage ? (
        <div className="center">
          <button type="button" className="btn" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}
      {editing ? <EditDialog video={editing} onClose={() => setEditing(null)} /> : null}
      {deleting ? (
        <ConfirmDialog
          title="Delete this video?"
          message={`“${deleting.title}” will be removed from the catalog. Viewers who already watched it keep their history and earnings stay yours.`}
          confirmLabel="Delete"
          danger
          pending={busyId === deleting.id}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void act(deleting.id, () => creatorApi.remove(deleting.id), 'Video deleted').then(() => setDeleting(null))}
        />
      ) : null}
    </>
  );
}

export function AnalyticsTab(): JSX.Element {
  const q = useQuery({ queryKey: keys.creatorAnalytics, queryFn: creatorApi.analytics });
  if (q.isPending) return <Skeleton className="block" />;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const a = q.data;
  const maxMinutes = Math.max(1, ...a.daily.map((d) => d.watchSeconds));
  return (
    <div>
      <div className="stats">
        <div className="stat">
          <p className="muted small">Views</p>
          <p className="stat-value">{a.totalViews}</p>
        </div>
        <div className="stat">
          <p className="muted small">Watch time</p>
          <p className="stat-value">{Math.round(a.totalWatchSeconds / 60)} min</p>
        </div>
        <div className="stat strong">
          <p className="muted small">Earned (settled)</p>
          <p className="stat-value" title={moneyTitle(a.totalEarningsWei)}>
            {money(a.totalEarningsWei)}
          </p>
        </div>
      </div>
      {a.videos.length === 0 ? (
        <EmptyState title="No data yet">Analytics appear after viewers watch your videos.</EmptyState>
      ) : (
        <>
          <h3>Last 30 days</h3>
          {a.daily.length === 0 ? (
            <p className="muted">No viewing in the last 30 days.</p>
          ) : (
            <ul className="bars" aria-label="Watch minutes per day">
              {a.daily.map((d) => (
                <li key={d.date} title={`${d.date}: ${Math.round(d.watchSeconds / 60)} min, ${d.views} views`}>
                  <span style={{ height: `${Math.max(4, Math.round((d.watchSeconds / maxMinutes) * 100))}%` }} />
                  <small>{d.date.slice(5)}</small>
                </li>
              ))}
            </ul>
          )}
          <table className="table">
            <thead>
              <tr>
                <th>Video</th>
                <th className="num">Views</th>
                <th className="num">Watch minutes</th>
                <th className="num">Earnings</th>
              </tr>
            </thead>
            <tbody>
              {a.videos.map((v) => (
                <tr key={v.videoId}>
                  <td>{v.title}</td>
                  <td className="num">{v.views}</td>
                  <td className="num">{Math.round(v.watchSeconds / 60)}</td>
                  <td className="num" title={moneyTitle(v.earningsWei)}>
                    {money(v.earningsWei)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

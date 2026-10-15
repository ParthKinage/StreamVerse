import { Link } from 'react-router-dom';
import type { VideoDto } from '@tesor_gp/shared';
import { useOwnedIds } from '../api/queries';
import { formatDuration, formatViews, moneyTitle, costLabel, timeAgo } from '../lib/format';

export function VideoCard({ video, progress }: { video: VideoDto; progress?: number | undefined }): JSX.Element {
  const onAir = video.live?.status === 'LIVE';
  const owned = useOwnedIds().has(video.id);
  const left = progress !== undefined && video.durationSeconds > 0 ? Math.max(0, video.durationSeconds - progress) : null;
  return (
    <article className="video-card">
      <Link to={`/watch/${video.id}`} className="thumb-link" aria-label={`Watch ${video.title}`}>
        <div className="thumb">
          {video.thumbnailUrl ? <img src={video.thumbnailUrl} alt="" loading="lazy" decoding="async" /> : <div className="thumb-fallback" aria-hidden="true" />}
          {onAir ? <span className="badge live">LIVE</span> : owned ? <span className="badge owned">Owned</span> : null}
          {!onAir && video.durationSeconds > 0 ? <span className="badge duration">{formatDuration(video.durationSeconds)}</span> : null}
          {progress !== undefined && video.durationSeconds > 0 ? (
            <span className="progress-bar" aria-hidden="true">
              <span style={{ width: `${Math.min(100, Math.round((progress / video.durationSeconds) * 100))}%` }} />
            </span>
          ) : null}
        </div>
      </Link>
      <div className="video-meta">
        <h3 className="video-title">
          <Link to={`/watch/${video.id}`}>{video.title}</Link>
        </h3>
        <p className="muted small">
          <Link to={`/channel/${video.creator.id}`}>{video.creator.channelName}</Link>
        </p>
        <p className="muted small">
          {onAir ? `${video.live?.viewers ?? 0} watching now` : `${formatViews(video.viewsCount)} · ${timeAgo(video.createdAt)}`}
          {video.live?.status === 'ENDED' ? ' · recorded live' : ''}
        </p>
        {left !== null ? <p className="muted small">{left < 60 ? 'Under a minute left' : `${Math.round(left / 60)} min left`}</p> : null}
        <p className="rate" title={moneyTitle(video.ratePerMinuteWei)}>
          {owned ? 'Yours to watch again' : costLabel(video)}
        </p>
      </div>
    </article>
  );
}

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { CreatorProfileDto } from '@tesor_gp/shared';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../api/client';
import { catalogApi, socialApi } from '../api/endpoints';
import { keys } from '../api/queries';
import { useToast } from './Toasts';

export const creatorKey = (id: string) => ['creator', id] as const;

/** Follow or unfollow a channel. Hidden on your own channel; signed out, it leads to the login page. */
export function FollowButton({ creatorId, showCount = false }: { creatorId: string; showCount?: boolean }): JSX.Element | null {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: creatorKey(creatorId), queryFn: () => catalogApi.creator(creatorId) });
  const c = q.data;
  if (!c || (user && user.username === c.username)) return null;
  const count = showCount ? <span className="follow-count">{c.followersCount.toLocaleString()}</span> : null;

  if (!user) {
    return (
      <Link className="btn small follow-btn" to={`/login?next=${encodeURIComponent(location.pathname)}`}>
        Follow {count}
      </Link>
    );
  }

  const toggle = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await socialApi.follow(creatorId);
      qc.setQueryData<CreatorProfileDto>(creatorKey(creatorId), (old) => (old ? { ...old, following: r.following, followersCount: r.followersCount } : old));
      toast.success(r.following ? `Following ${c.channelName}` : `Unfollowed ${c.channelName}`);
      await Promise.all([qc.invalidateQueries({ queryKey: keys.following }), qc.invalidateQueries({ queryKey: keys.feed })]);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className={`btn small follow-btn ${c.following ? '' : 'primary'}`} aria-pressed={Boolean(c.following)} disabled={busy} onClick={() => void toggle()}>
      {c.following ? 'Following' : 'Follow'} {count}
    </button>
  );
}

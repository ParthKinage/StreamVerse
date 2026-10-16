import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AdminReportItem, ResolveReportRequest } from '@tesor_gp/shared';
import { errorMessage } from '../../api/client';
import { adminApi } from '../../api/endpoints';
import { EmptyState, ErrorState, Skeleton } from '../../components/States';
import { useToast } from '../../components/Toasts';
import { money, timeAgo } from '../../lib/format';

const REASON_TEXT: Record<string, string> = { SPAM: 'Spam or scam', ABUSE: 'Abusive', SEXUAL: 'Sexual', COPYRIGHT: 'Copyright', OTHER: 'Other' };
const KIND_TEXT: Record<string, string> = { VIDEO: 'Video', CHAT_MESSAGE: 'Chat', CHANNEL: 'Channel' };

type Action = ResolveReportRequest['action'];

function actionsFor(item: AdminReportItem): Array<[Action, string, boolean]> {
  const out: Array<[Action, string, boolean]> = [];
  if (item.targetType === 'VIDEO') out.push(['hide_video', 'Hide video', true]);
  if (item.targetType === 'CHAT_MESSAGE') out.push(['remove_message', 'Delete', true]);
  if (item.target.ownerUserId) out.push(['suspend_owner', item.targetType === 'CHANNEL' ? 'Suspend channel' : 'Suspend user', true]);
  out.push(['dismiss', 'Dismiss', false]);
  return out;
}

function Overview(): JSX.Element {
  const q = useQuery({ queryKey: ['admin', 'overview'], queryFn: adminApi.overview, refetchInterval: 30_000 });
  if (!q.data) return <Skeleton className="line" />;
  const o = q.data;
  return (
    <dl className="stats" data-testid="admin-overview">
      <div>
        <dt>Open reports</dt>
        <dd data-testid="open-reports">{o.openReports}</dd>
      </div>
      <div>
        <dt>New users, 7 days</dt>
        <dd>{o.newUsers7d}</dd>
      </div>
      <div>
        <dt>Tips today</dt>
        <dd>{money(o.tipsTodayWei)}</dd>
      </div>
      <div>
        <dt>Suspended</dt>
        <dd>{o.suspendedUsers}</dd>
      </div>
      <div>
        <dt>Hidden videos</dt>
        <dd>{o.hiddenVideos}</dd>
      </div>
    </dl>
  );
}

/** The admins' queue: each reported item once, most reported first, with the actions that fit it. */
export function Reports(): JSX.Element {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<'OPEN' | 'ACTIONED' | 'DISMISSED'>('OPEN');
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['admin', 'reports', status], queryFn: () => adminApi.reports(status) });

  const act = async (item: AdminReportItem, action: Action): Promise<void> => {
    let reason: string | undefined;
    if (action !== 'dismiss') {
      const typed = window.prompt('Reason (shown to the creator; optional)');
      if (typed === null) return;
      reason = typed.trim() || undefined;
    }
    setBusy(`${item.targetType}:${item.targetId}`);
    try {
      await adminApi.resolve({ targetType: item.targetType, targetId: item.targetId, action, ...(reason ? { reason } : {}) });
      toast.success(action === 'dismiss' ? 'Reports dismissed' : 'Done');
      await qc.invalidateQueries({ queryKey: ['admin'] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <Overview />
      <div className="segmented" role="group" aria-label="Which reports">
        {(
          [
            ['OPEN', 'Open'],
            ['ACTIONED', 'Acted on'],
            ['DISMISSED', 'Dismissed'],
          ] as const
        ).map(([v, label]) => (
          <button key={v} type="button" className={status === v ? 'active' : ''} aria-pressed={status === v} onClick={() => setStatus(v)}>
            {label}
          </button>
        ))}
      </div>
      {q.isPending ? (
        <Skeleton className="block" />
      ) : q.isError ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <EmptyState title={status === 'OPEN' ? 'Nothing to review' : 'Nothing here yet'}>{status === 'OPEN' ? 'New reports from viewers will appear here.' : null}</EmptyState>
      ) : (
        <table className="table" data-testid="reports-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Reason</th>
              <th>Reports</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data.items.map((item) => {
              const key = `${item.targetType}:${item.targetId}`;
              const reasons = Object.entries(item.reasons).sort((a, b) => b[1] - a[1]);
              return (
                <tr key={key} data-testid="report-row">
                  <td>
                    <span className="muted small">{KIND_TEXT[item.targetType]} · </span>
                    {item.target.videoId ? <Link to={`/watch/${item.target.videoId}`}>{item.target.label}</Link> : item.target.label}
                    {item.target.ownerUsername ? <span className="muted small"> · @{item.target.ownerUsername}</span> : null}
                    {item.target.state ? <span className="badge"> {item.target.state}</span> : null}
                    {item.details.map((d, i) => (
                      <div key={i} className="muted small">
                        “{d}”
                      </div>
                    ))}
                  </td>
                  <td>
                    {reasons.map(([r, n]) => (
                      <div key={r}>
                        {REASON_TEXT[r] ?? r}
                        {n > 1 ? <span className="muted small"> ×{n}</span> : null}
                      </div>
                    ))}
                  </td>
                  <td>
                    {item.count}
                    <div className="muted small">{timeAgo(item.latestAt)}</div>
                  </td>
                  <td>
                    {status === 'OPEN' ? (
                      <div className="actions">
                        {actionsFor(item).map(([action, label, danger]) => (
                          <button key={action} type="button" className={danger ? 'btn small danger' : 'btn small'} disabled={busy === key} onClick={() => void act(item, action)}>
                            {label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

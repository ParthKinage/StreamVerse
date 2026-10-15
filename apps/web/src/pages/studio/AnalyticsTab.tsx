import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { CreatorAnalytics } from '@tesor_gp/shared';
import { errorMessage } from '../../api/client';
import { creatorApi } from '../../api/endpoints';
import { keys } from '../../api/queries';
import { EmptyState, ErrorState, Skeleton } from '../../components/States';
import { money, moneyTitle, toBig } from '../../lib/format';

type Metric = 'watch' | 'views' | 'earnings';
type SortKey = 'title' | 'views' | 'watch' | 'avg' | 'earnings';

const METRICS: Array<[Metric, string]> = [
  ['watch', 'Watch time'],
  ['views', 'Views'],
  ['earnings', 'Earnings'],
];

/** "2 h 05 min", "12 min", "45 s". */
export function watchTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** The last `days` days ending today (UTC), with zeros for days without any viewing, so gaps show as gaps. */
export function fillDays(daily: CreatorAnalytics['daily'], days = 30, today = new Date()): CreatorAnalytics['daily'] {
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const out: CreatorAnalytics['daily'] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    out.push(byDate.get(key) ?? { date: key, views: 0, watchSeconds: 0, earningsWei: '0' });
  }
  return out;
}

const valueOf = (d: CreatorAnalytics['daily'][number], m: Metric): number =>
  m === 'watch' ? d.watchSeconds : m === 'views' ? d.views : Number(toBig(d.earningsWei) / 10n ** 14n) / 1e4;

const labelOf = (d: CreatorAnalytics['daily'][number], m: Metric): string =>
  m === 'watch' ? watchTime(d.watchSeconds) : m === 'views' ? `${d.views} ${d.views === 1 ? 'view' : 'views'}` : money(d.earningsWei);

const dayLabel = (iso: string): string => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

function Kpi({ label, value, title, note }: { label: string; value: string; title?: string; note?: string }): JSX.Element {
  return (
    <div className="kpi">
      <p className="kpi-label">{label}</p>
      <p className="kpi-value" title={title}>
        {value}
      </p>
      {note ? <p className="kpi-note">{note}</p> : null}
    </div>
  );
}

/** One bar per day for the chosen measure; hover (or focus) a bar to read its exact value. */
function DailyChart({ days, metric }: { days: CreatorAnalytics['daily']; metric: Metric }): JSX.Element {
  const [active, setActive] = useState<number | null>(null);
  const values = days.map((d) => valueOf(d, metric));
  const max = Math.max(...values, 0);
  const shown = active !== null ? days[active] : undefined;
  return (
    <div className="chart">
      <div className="chart-readout" aria-live="polite">
        {shown ? (
          <>
            <span className="chart-readout-value">{labelOf(shown, metric)}</span>
            <span className="muted small">{dayLabel(shown.date)}</span>
          </>
        ) : (
          <span className="muted small">Hover a day to see its numbers</span>
        )}
      </div>
      <div className="chart-plot" onMouseLeave={() => setActive(null)}>
        <div className="chart-grid" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <ol className="chart-bars" aria-label={`${METRICS.find(([m]) => m === metric)?.[1]} per day, last 30 days`}>
          {days.map((d, i) => (
            <li key={d.date}>
              <button
                type="button"
                className={`chart-bar${active === i ? ' active' : ''}`}
                aria-label={`${dayLabel(d.date)}: ${labelOf(d, metric)}`}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              >
                <span style={{ height: max > 0 && values[i]! > 0 ? `${Math.max(3, (values[i]! / max) * 100)}%` : '0' }} />
              </button>
            </li>
          ))}
        </ol>
      </div>
      <div className="chart-axis" aria-hidden="true">
        <span>{dayLabel(days[0]!.date)}</span>
        <span>{dayLabel(days[Math.floor(days.length / 2)]!.date)}</span>
        <span>Today</span>
      </div>
    </div>
  );
}

export function AnalyticsTab(): JSX.Element {
  const q = useQuery({ queryKey: keys.creatorAnalytics, queryFn: creatorApi.analytics });
  const [metric, setMetric] = useState<Metric>('watch');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'earnings', desc: true });
  const a = q.data;
  const days = useMemo(() => (a ? fillDays(a.daily) : []), [a]);

  if (q.isPending) return <Skeleton className="block" />;
  if (q.isError || !a) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  if (a.videos.length === 0) return <EmptyState title="No data yet">Analytics appear after viewers watch your videos.</EmptyState>;

  const last30Earnings = days.reduce((sum, d) => sum + toBig(d.earningsWei), 0n);
  const last30Watch = days.reduce((sum, d) => sum + d.watchSeconds, 0);
  const totalEarnings = toBig(a.totalEarningsWei);
  const best = [...a.videos].sort((x, y) => (toBig(y.earningsWei) > toBig(x.earningsWei) ? 1 : -1) || y.watchSeconds - x.watchSeconds)[0];
  const avg = (v: { views: number; watchSeconds: number }): number => (v.views ? v.watchSeconds / v.views : 0);

  const rows = [...a.videos].sort((x, y) => {
    const dir = sort.desc ? -1 : 1;
    switch (sort.key) {
      case 'title':
        return dir * x.title.localeCompare(y.title);
      case 'views':
        return dir * (x.views - y.views);
      case 'watch':
        return dir * (x.watchSeconds - y.watchSeconds);
      case 'avg':
        return dir * (avg(x) - avg(y));
      default: {
        const ex = toBig(x.earningsWei);
        const ey = toBig(y.earningsWei);
        return dir * (ex === ey ? 0 : ex > ey ? 1 : -1);
      }
    }
  });
  const header = (key: SortKey, label: string, num = false): JSX.Element => (
    <th className={num ? 'num' : undefined} aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button type="button" className="sort-btn" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'title' }))}>
        {label}
        <span aria-hidden="true">{sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}</span>
      </button>
    </th>
  );

  return (
    <div className="analytics">
      <div className="kpis">
        <Kpi label="Views" value={a.totalViews.toLocaleString()} note="Sessions of 30 s or more" />
        <Kpi label="Watch time" value={watchTime(a.totalWatchSeconds)} note={`${watchTime(last30Watch)} in the last 30 days`} />
        <Kpi label="Average per view" value={watchTime(a.totalViews ? a.totalWatchSeconds / a.totalViews : 0)} />
        <Kpi label="Earned" value={money(totalEarnings)} title={moneyTitle(totalEarnings)} note={`${money(last30Earnings)} in the last 30 days`} />
      </div>

      {best ? (
        <div className="best-video">
          <p className="eyebrow">Top video</p>
          <p className="best-title">{best.title}</p>
          <p className="muted small">
            {money(best.earningsWei)} earned · {best.views.toLocaleString()} views · {watchTime(best.watchSeconds)} watched
          </p>
        </div>
      ) : null}

      <section className="card chart-card" aria-label="Last 30 days">
        <div className="chart-head">
          <h3>Last 30 days</h3>
          <div className="segmented" role="group" aria-label="Measure">
            {METRICS.map(([m, label]) => (
              <button key={m} type="button" className={metric === m ? 'active' : ''} aria-pressed={metric === m} onClick={() => setMetric(m)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <DailyChart days={days} metric={metric} />
      </section>

      <h3 className="table-title">By video</h3>
      <table className="table analytics-table">
        <thead>
          <tr>
            {header('title', 'Video')}
            {header('views', 'Views', true)}
            {header('watch', 'Watch time', true)}
            {header('avg', 'Avg per view', true)}
            {header('earnings', 'Earnings', true)}
            <th className="share-col">Share of earnings</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => {
            const share = totalEarnings > 0n ? Number((toBig(v.earningsWei) * 1000n) / totalEarnings) / 10 : 0;
            return (
              <tr key={v.videoId}>
                <td>{v.title}</td>
                <td className="num">{v.views.toLocaleString()}</td>
                <td className="num">{watchTime(v.watchSeconds)}</td>
                <td className="num">{watchTime(avg(v))}</td>
                <td className="num" title={moneyTitle(v.earningsWei)}>
                  {money(v.earningsWei)}
                </td>
                <td className="share-col">
                  <span className="share">
                    <span className="share-bar" aria-hidden="true">
                      <span style={{ width: `${share}%` }} />
                    </span>
                    <span className="share-value">{share.toFixed(share < 10 ? 1 : 0)}%</span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

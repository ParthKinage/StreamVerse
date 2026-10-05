import { formatDuration } from '../lib/format';
import type { SessionState } from './sessionMachine';

function untilLabel(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

/** What the viewer sees while a video plays: time watched and how long the paid access lasts. Watching itself costs nothing extra. */
export function CostMeter({ state }: { state: SessionState }): JSX.Element | null {
  if (state.phase === 'idle' || state.phase === 'starting') return null;
  return (
    <dl className="cost-meter" aria-label="Playback" data-testid="cost-meter">
      <div>
        <dt>Time watched</dt>
        <dd data-testid="meter-time">{formatDuration(state.verifiedSeconds)}</dd>
      </div>
      <div>
        <dt>Access</dt>
        <dd data-testid="meter-access">{state.free ? 'Free' : `Until ${untilLabel(state.accessUntil)}`}</dd>
      </div>
    </dl>
  );
}

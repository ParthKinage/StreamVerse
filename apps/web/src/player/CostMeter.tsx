import { formatDuration, money, rateLabel } from '../lib/format';
import type { SessionState } from './sessionMachine';

/** What the viewer sees while a video plays: time watched, the rate, what this session has cost and the balance. */
export function CostMeter({ state }: { state: SessionState }): JSX.Element | null {
  if (state.phase === 'idle' || state.phase === 'starting' || !state.sessionId) return null;
  return (
    <dl className="cost-meter" aria-label="Playback cost" data-testid="cost-meter">
      <div>
        <dt>Time watched</dt>
        <dd data-testid="meter-time">{formatDuration(state.verifiedSeconds)}</dd>
      </div>
      <div>
        <dt>Rate</dt>
        <dd data-testid="meter-rate">{state.free ? 'Free' : rateLabel(state.ratePerMinuteWei)}</dd>
      </div>
      {state.free ? null : (
        <>
          <div>
            <dt>This session</dt>
            <dd data-testid="meter-spent">{money(state.chargedWei)}</dd>
          </div>
          <div>
            <dt>Balance</dt>
            <dd data-testid="meter-balance" className={state.lowBalance ? 'warn' : undefined}>
              {money(state.availableWei)}
              {state.lowBalance && state.secondsRemaining !== null ? ` · about ${formatDuration(state.secondsRemaining)} left` : ''}
            </dd>
          </div>
        </>
      )}
    </dl>
  );
}

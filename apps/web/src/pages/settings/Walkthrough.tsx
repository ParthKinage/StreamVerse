import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { useBankMode, useManagedMode } from '../../api/queries';
import { chapters, rememberStep, type MoneyWords } from './walkthroughData';

/** A guided tour of the whole app: one chapter at a time, each with buttons that open the page it describes. */
export function Walkthrough(): JSX.Element {
  const { user } = useAuth();
  const bank = useBankMode();
  const managed = useManagedMode();
  const [params, setParams] = useSearchParams();
  const words: MoneyWords = bank ? { addMoney: 'Add money', balance: 'balance' } : managed ? { addMoney: 'Buy coins', balance: 'coin balance' } : { addMoney: 'Top up', balance: 'balance' };
  const list = chapters(words).filter((c) => !c.adminOnly || user?.role === 'ADMIN');
  const raw = Number(params.get('step') ?? 0);
  const step = Number.isInteger(raw) && raw >= 0 && raw < list.length ? raw : 0;
  const chapter = list[step] ?? list[0]!;

  // Remember where the viewer is, so "Back to walkthrough" returns here after they open a page.
  useEffect(() => rememberStep(step), [step]);

  const go = (n: number): void => {
    const next = new URLSearchParams(params);
    next.set('tab', 'walkthrough');
    next.set('step', String(n));
    setParams(next, { replace: true });
  };

  return (
    <div className="walkthrough">
      <ol className="walk-index" aria-label="Chapters">
        {list.map((c, i) => (
          <li key={c.id}>
            <button type="button" className={i === step ? 'walk-chapter active' : 'walk-chapter'} aria-current={i === step ? 'step' : undefined} onClick={() => go(i)}>
              <span className="walk-num">{String(i + 1).padStart(2, '0')}</span>
              {c.title}
            </button>
          </li>
        ))}
      </ol>
      <section className="card walk-step" aria-labelledby="walk-title" data-testid="walk-step">
        <p className="eyebrow">
          Step {step + 1} of {list.length}
        </p>
        <h2 id="walk-title">{chapter.title}</h2>
        <p className="walk-intro">{chapter.intro}</p>
        <ul className="walk-points">
          {chapter.points.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        {chapter.links.length ? (
          <div className="actions">
            {chapter.links.map((l) => (
              <Link key={l.to} to={l.to} className="btn" data-testid="walk-open">
                {l.label}
              </Link>
            ))}
          </div>
        ) : null}
        <div className="walk-nav">
          <button type="button" className="btn" disabled={step === 0} onClick={() => go(step - 1)}>
            Back
          </button>
          {step < list.length - 1 ? (
            <button type="button" className="btn primary" onClick={() => go(step + 1)} data-testid="walk-next">
              Next: {list[step + 1]!.title}
            </button>
          ) : (
            <Link to="/" className="btn primary">
              Start watching
            </Link>
          )}
        </div>
      </section>
    </div>
  );
}

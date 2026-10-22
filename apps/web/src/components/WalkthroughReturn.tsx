import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { X } from 'lucide-react';
import { forgetStep, rememberedStep } from '../pages/settings/walkthroughData';

/**
 * While someone follows the walkthrough, a small button on every other page takes them back to the step they were on.
 * It disappears on the walkthrough itself, and for good once dismissed (until the walkthrough is opened again).
 */
export function WalkthroughReturn(): JSX.Element | null {
  const location = useLocation();
  const [step, setStep] = useState<number | null>(null);
  useEffect(() => setStep(rememberedStep()), [location.pathname, location.search]);
  const onWalkthrough = location.pathname === '/settings' && new URLSearchParams(location.search).get('tab') === 'walkthrough';
  if (step === null || onWalkthrough) return null;
  return (
    <div className="walk-return" role="region" aria-label="Walkthrough">
      <Link to={`/settings?tab=walkthrough&step=${step}`} className="btn primary small" data-testid="walk-return">
        Back to walkthrough · step {step + 1}
      </Link>
      <button
        type="button"
        className="icon-btn"
        aria-label="Close walkthrough"
        onClick={() => {
          forgetStep();
          setStep(null);
        }}
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}

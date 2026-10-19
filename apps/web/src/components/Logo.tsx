/** A half-disc facing right: an elliptical arc closed by a flatter one, centred on the mark's axis (y = 50). */
function shell(cx: number, ry: number, rx: number): string {
  return `M${cx} ${50 - ry} A${rx} ${ry} 0 0 1 ${cx} ${50 + ry} A${rx * 0.35} ${ry} 0 0 0 ${cx} ${50 - ry} Z`;
}

/** The shells, smallest first; the fifth is red. Shared with the favicon and the splash screen. */
export const MARK_SHELLS: Array<{ cx: number; ry: number; rx: number; opacity: number }> = [
  { cx: 30, ry: 8, rx: 4, opacity: 0.35 },
  { cx: 38, ry: 14, rx: 7, opacity: 0.5 },
  { cx: 48, ry: 21, rx: 10, opacity: 0.68 },
  { cx: 60, ry: 29, rx: 13, opacity: 0.86 },
  { cx: 74, ry: 37, rx: 16, opacity: 1 },
];
export const MARK_WORLD = 'M86 16 A34 34 0 0 1 86 84 A14 34 0 0 1 86 16 Z';

/**
 * The StreamVerse mark, "multiverse rings": a streak of light runs into half-discs that grow from left to right, the
 * last of them red, in front of a grey world. Uses the current text colour and the theme's accent, so it fits both
 * themes. Drawn on a 120 x 100 grid.
 */
export function LogoMark({ size = 32, className = '' }: { size?: number; className?: string }): JSX.Element {
  return (
    <svg className={`logo-mark ${className}`.trim()} viewBox="0 0 120 100" width={Math.round(size * 1.2)} height={size} aria-hidden="true" focusable="false">
      <path d={MARK_WORLD} fill="currentColor" opacity="0.32" />
      <path d="M2 50 H34" stroke="currentColor" strokeWidth="1.4" opacity="0.55" />
      <path d="M14 46 H30 M18 54 H30" stroke="currentColor" strokeWidth="0.8" opacity="0.35" />
      {MARK_SHELLS.map((s, i) => (
        <path key={s.cx} d={shell(s.cx, s.ry, s.rx)} fill={i === MARK_SHELLS.length - 1 ? 'var(--accent)' : 'currentColor'} opacity={s.opacity} />
      ))}
    </svg>
  );
}

/** The A of the wordmark: a red peak without a crossbar. */
function PeakA(): JSX.Element {
  return (
    <svg className="wordmark-a" viewBox="0 0 20 22" aria-hidden="true" focusable="false">
      <path d="M2 21 L10 2 L18 21" fill="none" stroke="currentColor" strokeWidth="2.2" />
    </svg>
  );
}

/** "STREAMVERSE" in wide capitals with the red peak for its A. Screen readers hear "StreamVerse". */
export function Wordmark({ className = '' }: { className?: string }): JSX.Element {
  return (
    <span className={`wordmark ${className}`.trim()} role="img" aria-label="StreamVerse">
      <span aria-hidden="true">STRE</span>
      <PeakA />
      <span aria-hidden="true">MVERSE</span>
    </span>
  );
}

/** "WATCH —— BEYOND" with a red rule between the words. */
export function Tagline(): JSX.Element {
  return (
    <span className="tagline">
      Watch <i aria-hidden="true" /> beyond
    </span>
  );
}

/** Mark and wordmark side by side, as in the site header. */
export function Logo({ markSize = 30 }: { markSize?: number }): JSX.Element {
  return (
    <span className="logo">
      <LogoMark size={markSize} />
      <Wordmark />
    </span>
  );
}

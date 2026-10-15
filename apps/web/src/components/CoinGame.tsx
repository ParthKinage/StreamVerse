import { useEffect, useRef, useState } from 'react';

const BEST_KEY = 'streamverse.coinGame.best';

function readBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function saveBest(n: number): void {
  try {
    localStorage.setItem(BEST_KEY, String(n));
  } catch {
    // private mode or blocked storage: the best score just isn't remembered
  }
}

interface Coin {
  x: number;
  y: number;
  vy: number;
  r: number;
}

interface Props {
  /** "panel": inside the small waiting panel. "full": across the whole screen, behind the loading message. */
  variant?: 'panel' | 'full';
}

/**
 * A small game for waiting: move the tray (mouse, finger or arrow keys) to catch falling StreamCoins. Sizes and speeds
 * follow the canvas, so it plays the same in the panel and across the whole screen. It draws with
 * requestAnimationFrame and does nothing while the tab is hidden.
 */
export function CoinGame({ variant = 'panel' }: Props): JSX.Element {
  const full = variant === 'full';
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(readBest);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--accent').trim() || '#b89b66';
    const line = css.getPropertyValue('--line-strong').trim() || '#34405a';
    const ink = css.getPropertyValue('--on-accent').trim() || '#0d111a';

    let width = 0;
    let height = 0;
    const tray = { x: 0, w: 64, h: 6 };
    let radius = 9;
    let speed = 1;
    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Scale with the play area: a coin takes about the same time to fall in the panel and on a full screen.
      radius = full ? Math.max(11, Math.min(18, width / 70)) : 9;
      tray.w = full ? Math.max(96, Math.min(180, width / 9)) : 64;
      tray.h = full ? 8 : 6;
      speed = height / 210;
    };
    resize();
    tray.x = width / 2;

    let target = tray.x;
    const coins: Coin[] = [];
    const sparks: Array<{ x: number; y: number; life: number }> = [];
    let caught = 0;
    let bestNow = readBest();
    let spawnIn = 0;
    let last = performance.now();
    let frame = 0;

    const keys = { left: false, right: false };
    const onKey = (e: KeyboardEvent, down: boolean): void => {
      if (e.key === 'ArrowLeft') keys.left = down;
      else if (e.key === 'ArrowRight') keys.right = down;
      else return;
      e.preventDefault();
    };
    const keyDown = (e: KeyboardEvent): void => onKey(e, true);
    const keyUp = (e: KeyboardEvent): void => onKey(e, false);
    const onMove = (e: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      target = e.clientX - rect.left;
    };
    // Full screen: the loading message sits on top of the canvas, so listen on the whole window.
    const pointerTarget: HTMLElement | Window = full ? window : canvas;
    const keyTarget: HTMLElement | Window = full ? window : canvas;
    pointerTarget.addEventListener('pointermove', onMove as EventListener);
    pointerTarget.addEventListener('pointerdown', onMove as EventListener);
    keyTarget.addEventListener('keydown', keyDown as EventListener);
    keyTarget.addEventListener('keyup', keyUp as EventListener);
    window.addEventListener('resize', resize);

    const drawCoin = (c: Coin): void => {
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.fillStyle = ink;
      ctx.font = `700 ${Math.round(c.r * 1.1)}px Manrope, Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('S', c.x, c.y + 1);
    };

    const tick = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (document.visibilityState === 'visible') {
        if (keys.left) target -= width * 0.9 * dt;
        if (keys.right) target += width * 0.9 * dt;
        target = Math.max(tray.w / 2, Math.min(width - tray.w / 2, target));
        tray.x += (target - tray.x) * Math.min(1, dt * 14);

        // New coins arrive a little faster as the score grows; a wide screen gets more of them at once.
        spawnIn -= dt;
        if (spawnIn <= 0) {
          coins.push({ x: radius + 4 + Math.random() * (width - 2 * radius - 8), y: -radius, vy: (70 + Math.random() * 60 + caught * 2.5) * speed, r: radius });
          const lanes = full ? Math.max(1, width / 420) : 1;
          spawnIn = Math.max(0.3, 0.9 - caught * 0.015) / lanes;
        }

        const trayY = height - (full ? 28 : 18);
        for (let i = coins.length - 1; i >= 0; i--) {
          const c = coins[i]!;
          c.y += c.vy * dt;
          if (c.y + c.r >= trayY && c.y - c.r <= trayY + tray.h && Math.abs(c.x - tray.x) <= tray.w / 2 + c.r * 0.6) {
            coins.splice(i, 1);
            caught++;
            sparks.push({ x: c.x, y: trayY, life: 1 });
            setScore(caught);
            if (caught > bestNow) {
              bestNow = caught;
              setBest(caught);
              saveBest(caught);
            }
          } else if (c.y - c.r > height) {
            coins.splice(i, 1);
          }
        }

        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = line;
        ctx.fillRect(0, height - 1, width, 1);
        for (const c of coins) drawCoin(c);
        for (let i = sparks.length - 1; i >= 0; i--) {
          const s = sparks[i]!;
          s.life -= dt * 2.5;
          if (s.life <= 0) {
            sparks.splice(i, 1);
            continue;
          }
          ctx.globalAlpha = s.life;
          ctx.fillStyle = accent;
          ctx.font = `600 ${full ? 14 : 11}px Inter, sans-serif`;
          ctx.fillText('+1', s.x, s.y - 14 - (1 - s.life) * 22);
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = accent;
        ctx.fillRect(tray.x - tray.w / 2, trayY, tray.w, tray.h);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      pointerTarget.removeEventListener('pointermove', onMove as EventListener);
      pointerTarget.removeEventListener('pointerdown', onMove as EventListener);
      keyTarget.removeEventListener('keydown', keyDown as EventListener);
      keyTarget.removeEventListener('keyup', keyUp as EventListener);
      window.removeEventListener('resize', resize);
    };
  }, [full]);

  const label = 'Game: move the tray with the mouse, a finger or the arrow keys to catch falling StreamCoins';
  if (full) {
    return (
      <>
        <canvas ref={canvasRef} className="coin-game full" role="img" aria-label={label} data-testid="coin-game" />
        <div className="coin-game-score" aria-live="off">
          <span data-testid="coin-score">Caught {score}</span>
          <span>Best {best}</span>
        </div>
      </>
    );
  }
  return (
    <div>
      <canvas ref={canvasRef} className="coin-game" tabIndex={0} role="img" aria-label={label} data-testid="coin-game" />
      <div className="coin-game-foot">
        <span data-testid="coin-score">Caught {score}</span>
        <span>Best {best}</span>
      </div>
    </div>
  );
}

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

/**
 * A small game for waiting: move the tray (mouse, finger or arrow keys) to catch falling StreamCoins. It only runs
 * while it is on screen and the tab is visible, and draws with requestAnimationFrame, so it costs nothing otherwise.
 */
export function CoinGame(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(readBest);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;
    const css = getComputedStyle(document.documentElement);
    const sand = css.getPropertyValue('--accent').trim() || '#c8b79e';
    const line = css.getPropertyValue('--line-strong').trim() || '#3d3a36';
    const ink = css.getPropertyValue('--on-accent').trim() || '#121212';

    let width = 0;
    let height = 0;
    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const tray = { x: width / 2, w: 64, h: 6 };
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
    const point = (clientX: number): void => {
      const rect = canvas.getBoundingClientRect();
      target = Math.max(tray.w / 2, Math.min(width - tray.w / 2, clientX - rect.left));
    };
    const onMove = (e: PointerEvent): void => point(e.clientX);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onMove);
    canvas.addEventListener('keydown', keyDown);
    canvas.addEventListener('keyup', keyUp);
    window.addEventListener('resize', resize);

    const drawCoin = (c: Coin): void => {
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
      ctx.fillStyle = sand;
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
        // Move the tray toward the pointer, or with the arrow keys.
        if (keys.left) target -= 360 * dt;
        if (keys.right) target += 360 * dt;
        target = Math.max(tray.w / 2, Math.min(width - tray.w / 2, target));
        tray.x += (target - tray.x) * Math.min(1, dt * 14);

        // New coins arrive a little faster as the score grows.
        spawnIn -= dt;
        if (spawnIn <= 0) {
          coins.push({ x: 12 + Math.random() * (width - 24), y: -10, vy: 70 + Math.random() * 60 + caught * 2.5, r: 9 });
          spawnIn = Math.max(0.35, 0.9 - caught * 0.015);
        }

        const trayY = height - 18;
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
          ctx.fillStyle = sand;
          ctx.font = '600 11px Inter, sans-serif';
          ctx.fillText('+1', s.x, s.y - 14 - (1 - s.life) * 18);
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = sand;
        ctx.fillRect(tray.x - tray.w / 2, trayY, tray.w, tray.h);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onMove);
      canvas.removeEventListener('keydown', keyDown);
      canvas.removeEventListener('keyup', keyUp);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <div>
      <canvas
        ref={canvasRef}
        className="coin-game"
        tabIndex={0}
        role="img"
        aria-label="Game: move the tray with the mouse or the arrow keys to catch falling StreamCoins"
        data-testid="coin-game"
      />
      <div className="coin-game-foot">
        <span data-testid="coin-score">Caught {score}</span>
        <span>Best {best}</span>
      </div>
    </div>
  );
}

import { describe, expect, it } from 'vitest';
import { cameraRect, containRect } from './compositor';

describe('mixing screen and camera', () => {
  it('fits the screen inside the frame without cutting it', () => {
    expect(containRect(1920, 1080, 1280, 720)).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
    // A tall window is letterboxed left and right.
    expect(containRect(1000, 1000, 1280, 720)).toEqual({ x: 280, y: 0, w: 720, h: 720 });
    // An ultra-wide screen gets bars above and below.
    expect(containRect(3440, 1440, 1280, 720)).toEqual({ x: 0, y: 92, w: 1280, h: 536 });
  });

  it('puts the camera in the chosen corner at its own aspect ratio', () => {
    const layout = { width: 1280, height: 720, cameraShare: 0.25, corner: 'bottom-right' as const };
    expect(cameraRect(640, 480, layout)).toEqual({ x: 1280 - 320 - 26, y: 720 - 240 - 26, w: 320, h: 240 });
    expect(cameraRect(1280, 720, { ...layout, corner: 'top-left' })).toEqual({ x: 26, y: 26, w: 320, h: 180 });
  });
});

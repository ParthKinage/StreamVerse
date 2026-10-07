import { describe, expect, it } from 'vitest';
import { fragmentDurationMs, readTracks } from './fmp4';

/** Builds a box: 4-byte size, 4-character type, payload. */
function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let pos = 8;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
const u32 = (...values: number[]): Uint8Array => {
  const out = new Uint8Array(values.length * 4);
  values.forEach((v, i) => new DataView(out.buffer).setUint32(i * 4, v));
  return out;
};
const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
const concat = (...parts: Uint8Array[]): Uint8Array => box('wrap', ...parts).slice(8);

function trak(trackId: number, timescale: number, handler: string): Uint8Array {
  const tkhd = box('tkhd', u32(0, 0, 0, trackId));
  const mdhd = box('mdhd', u32(0, 0, 0, timescale, 0));
  const hdlr = box('hdlr', u32(0, 0), ascii(handler), u32(0, 0, 0));
  return box('trak', tkhd, box('mdia', mdhd, hdlr));
}

const init = concat(
  box('ftyp', ascii('isom'), u32(0)),
  box('moov', trak(1, 90_000, 'vide'), trak(2, 48_000, 'soun'), box('mvex', box('trex', u32(0, 1, 1, 3000, 0, 0)), box('trex', u32(0, 2, 1, 1024, 0, 0)))),
);

describe('reading a live piece', () => {
  it('finds the video and audio tracks in the init piece', () => {
    expect(readTracks(init)).toEqual([
      { trackId: 1, timescale: 90_000, kind: 'video', defaultSampleDuration: 3000 },
      { trackId: 2, timescale: 48_000, kind: 'audio', defaultSampleDuration: 1024 },
    ]);
  });

  it('measures a fragment from its video samples, with per-sample or default durations', () => {
    const tracks = readTracks(init);
    // Video: 120 samples of 3000/90000 s (default duration) = 4 s. Audio: 2 samples given explicitly.
    const videoTraf = box('traf', box('tfhd', u32(0x020000, 1)), box('trun', u32(0x000001, 120, 0)));
    const audioTraf = box('traf', box('tfhd', u32(0x020000, 2)), box('trun', u32(0x000100, 2, 1024, 1024)));
    const fragment = concat(box('moof', box('mfhd', u32(0, 7)), videoTraf, audioTraf), box('mdat', new Uint8Array(16)));
    expect(fragmentDurationMs(fragment, tracks)).toBe(4000);

    // Per-sample durations in the video track, and a default set in tfhd (flag 0x8) that it overrides.
    const explicit = box('traf', box('tfhd', u32(0x000008, 1, 1)), box('trun', u32(0x000301, 3, 0, 30_000, 10, 30_000, 10, 30_000, 10)));
    expect(fragmentDurationMs(box('moof', explicit), tracks)).toBe(1000);
    const tfhdDefault = box('traf', box('tfhd', u32(0x000008, 1, 45_000)), box('trun', u32(0x000000, 4)));
    expect(fragmentDurationMs(box('moof', tfhdDefault), tracks)).toBe(2000);
  });

  it('returns nothing for bytes that are not a fragment', () => {
    expect(fragmentDurationMs(new Uint8Array([1, 2, 3]), readTracks(init))).toBeUndefined();
    expect(readTracks(new Uint8Array(4))).toEqual([]);
  });
});

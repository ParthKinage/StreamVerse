/**
 * Just enough of the ISO-BMFF (MP4) format to measure a fragment: the init piece (moov) says which track is video and
 * its time scale; each fragment (moof) lists its samples' durations. The length of a piece is what viewers are
 * charged for, so it is read from the media itself rather than from a clock.
 */

interface Box {
  type: string;
  /** Offset of the payload (after the header) in the buffer. */
  start: number;
  end: number;
}

function* boxes(view: DataView, from: number, to: number): Generator<Box> {
  let pos = from;
  while (pos + 8 <= to) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(view.getUint8(pos + 4), view.getUint8(pos + 5), view.getUint8(pos + 6), view.getUint8(pos + 7));
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = to - pos;
    }
    if (size < header || pos + size > to) return;
    yield { type, start: pos + header, end: pos + size };
    pos += size;
  }
}

function child(view: DataView, parent: Box, type: string): Box | undefined {
  for (const b of boxes(view, parent.start, parent.end)) if (b.type === type) return b;
  return undefined;
}

function children(view: DataView, parent: Box, type: string): Box[] {
  return Array.from(boxes(view, parent.start, parent.end)).filter((b) => b.type === type);
}

function top(view: DataView, type: string): Box | undefined {
  for (const b of boxes(view, 0, view.byteLength)) if (b.type === type) return b;
  return undefined;
}

const viewOf = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export interface TrackInfo {
  trackId: number;
  timescale: number;
  kind: 'video' | 'audio' | 'other';
  /** From mvex/trex: used when a fragment does not give sample durations itself. */
  defaultSampleDuration: number;
}

/** Reads the tracks from an init piece (ftyp + moov). */
export function readTracks(init: Uint8Array): TrackInfo[] {
  const view = viewOf(init);
  const moov = top(view, 'moov');
  if (!moov) return [];
  const defaults = new Map<number, number>();
  const mvex = child(view, moov, 'mvex');
  if (mvex) for (const trex of children(view, mvex, 'trex')) defaults.set(view.getUint32(trex.start + 4), view.getUint32(trex.start + 12));
  const out: TrackInfo[] = [];
  for (const trak of children(view, moov, 'trak')) {
    const tkhd = child(view, trak, 'tkhd');
    const mdia = child(view, trak, 'mdia');
    const mdhd = mdia && child(view, mdia, 'mdhd');
    const hdlr = mdia && child(view, mdia, 'hdlr');
    if (!tkhd || !mdhd || !hdlr) continue;
    const trackId = view.getUint32(tkhd.start + (view.getUint8(tkhd.start) === 1 ? 20 : 12));
    const timescale = view.getUint32(mdhd.start + (view.getUint8(mdhd.start) === 1 ? 20 : 12));
    const handler = String.fromCharCode(...Array.from({ length: 4 }, (_, i) => view.getUint8(hdlr.start + 8 + i)));
    out.push({ trackId, timescale, kind: handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : 'other', defaultSampleDuration: defaults.get(trackId) ?? 0 });
  }
  return out;
}

/** Length in milliseconds of one fragment (moof, optionally followed by its mdat), measured on the video track if there is one. */
export function fragmentDurationMs(fragment: Uint8Array, tracks: TrackInfo[]): number | undefined {
  const view = viewOf(fragment);
  const moof = top(view, 'moof');
  if (!moof) return undefined;
  const durations = new Map<number, number>();
  for (const traf of children(view, moof, 'traf')) {
    const tfhd = child(view, traf, 'tfhd');
    if (!tfhd) continue;
    const tfhdFlags = view.getUint32(tfhd.start) & 0xffffff;
    const trackId = view.getUint32(tfhd.start + 4);
    const track = tracks.find((t) => t.trackId === trackId);
    let p = tfhd.start + 8;
    if (tfhdFlags & 0x1) p += 8; // base data offset
    if (tfhdFlags & 0x2) p += 4; // sample description index
    let defaultDuration = track?.defaultSampleDuration ?? 0;
    if (tfhdFlags & 0x8) defaultDuration = view.getUint32(p);
    let total = 0;
    for (const trun of children(view, traf, 'trun')) {
      const flags = view.getUint32(trun.start) & 0xffffff;
      const count = view.getUint32(trun.start + 4);
      let q = trun.start + 8;
      if (flags & 0x1) q += 4; // data offset
      if (flags & 0x4) q += 4; // first sample flags
      const perSample = (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
      for (let i = 0; i < count; i++, q += perSample) total += flags & 0x100 ? view.getUint32(q) : defaultDuration;
    }
    durations.set(trackId, total);
  }
  const pick = tracks.find((t) => t.kind === 'video' && durations.has(t.trackId)) ?? tracks.find((t) => durations.has(t.trackId));
  if (!pick || !pick.timescale) return undefined;
  return Math.round(((durations.get(pick.trackId) ?? 0) * 1000) / pick.timescale);
}

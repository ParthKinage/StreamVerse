import type { AiCandidate, AiRecommendRequest } from '@tesor_gp/shared';

export const WEIGHTS = { similarity: 0.4, category: 0.15, creator: 0.1, popularity: 0.2, recency: 0.15 } as const;
/** With no seed and no history there is nothing to personalise on: popularity and recency only. */
export const COLD_WEIGHTS = { popularity: 0.6, recency: 0.4 } as const;
const RECENCY_HALF_LIFE_DAYS = 30;
const DAY_MS = 86_400_000;

const STOPWORDS = new Set(
  'a an and are as at be but by for from has have how i in is it its of on or our that the their this to was we what when where which who why will with you your'.split(' '),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

type Vector = Map<string, number>;

function termFrequencies(c: Pick<AiCandidate, 'title' | 'description' | 'tags' | 'category'>): Vector {
  const tf: Vector = new Map();
  const add = (tokens: string[], weight: number): void => {
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + weight);
  };
  add(tokenize(c.title), 2);
  add(tokenize(c.description), 1);
  add(c.tags.flatMap(tokenize), 2);
  add(tokenize(c.category), 1);
  return tf;
}

function norm(v: Vector): number {
  let s = 0;
  for (const x of v.values()) s += x * x;
  return Math.sqrt(s);
}

function cosine(a: Vector, b: Vector): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, x] of small) dot += x * (large.get(k) ?? 0);
  return dot / (na * nb);
}

function tfidf(tf: Vector, idf: Map<string, number>): Vector {
  const out: Vector = new Map();
  for (const [t, f] of tf) out.set(t, (1 + Math.log(f)) * (idf.get(t) ?? Math.log(2) + 1));
  return out;
}

function addScaled(into: Vector, v: Vector, scale: number): void {
  for (const [t, x] of v) into.set(t, (into.get(t) ?? 0) + x * scale);
}

export interface Scored {
  id: string;
  creatorId: string;
  score: number;
}

/** Scores every eligible candidate. Pure and deterministic: the same input always gives the same output. */
export function scoreCandidates(req: AiRecommendRequest): Scored[] {
  const watched = new Set(req.watchedVideoIds ?? []);
  if (req.seedVideo) watched.add(req.seedVideo.id);
  const eligible = req.candidates.filter((c) => !watched.has(c.id));
  if (eligible.length === 0) return [];

  // Document frequencies over everything we know about (candidates + seed) give stable IDF weights.
  const corpus = [...req.candidates, ...(req.seedVideo ? [req.seedVideo] : [])];
  const tfs = new Map<string, Vector>(corpus.map((c) => [c.id, termFrequencies(c)]));
  const df = new Map<string, number>();
  for (const tf of tfs.values()) for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = new Map<string, number>([...df].map(([t, n]) => [t, Math.log((corpus.length + 1) / (n + 1)) + 1]));

  // Interest profile: the seed video plus everything watched, weighted by how long it was watched.
  const profile: Vector = new Map();
  if (req.seedVideo) addScaled(profile, tfidf(tfs.get(req.seedVideo.id) ?? new Map(), idf), 1);
  const categoryWeight = new Map<string, number>();
  const creatorWeight = new Map<string, number>();
  let historyTotal = 0;
  for (const h of req.history) {
    const w = Math.log1p(Math.max(0, h.watchedSeconds));
    if (w === 0) continue;
    historyTotal += w;
    categoryWeight.set(h.category, (categoryWeight.get(h.category) ?? 0) + w);
    creatorWeight.set(h.creatorId, (creatorWeight.get(h.creatorId) ?? 0) + w);
    const tf = termFrequencies({ title: '', description: '', category: h.category, tags: h.tags });
    addScaled(profile, tfidf(tf, idf), w / Math.max(1, req.history.length));
  }
  if (req.seedVideo) {
    categoryWeight.set(req.seedVideo.category, (categoryWeight.get(req.seedVideo.category) ?? 0) + Math.max(1, historyTotal));
    creatorWeight.set(req.seedVideo.creatorId, (creatorWeight.get(req.seedVideo.creatorId) ?? 0) + Math.max(1, historyTotal) * 0.5);
  }
  const catTotal = Math.max(...categoryWeight.values(), 0);
  const creatorTotal = Math.max(...creatorWeight.values(), 0);
  const personalised = profile.size > 0 || catTotal > 0;

  const maxViews = Math.max(...eligible.map((c) => c.views), 0);
  const reference = Math.max(...corpus.map((c) => Date.parse(c.createdAt) || 0));

  return eligible.map((c) => {
    const popularity = maxViews > 0 ? Math.log1p(c.views) / Math.log1p(maxViews) : 0;
    const ageDays = Math.max(0, (reference - (Date.parse(c.createdAt) || reference)) / DAY_MS);
    const recency = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
    let score: number;
    if (personalised) {
      const similarity = cosine(profile, tfidf(tfs.get(c.id) ?? new Map(), idf));
      const category = catTotal > 0 ? (categoryWeight.get(c.category) ?? 0) / catTotal : 0;
      const creator = creatorTotal > 0 ? (creatorWeight.get(c.creatorId) ?? 0) / creatorTotal : 0;
      score =
        WEIGHTS.similarity * similarity + WEIGHTS.category * category + WEIGHTS.creator * creator + WEIGHTS.popularity * popularity + WEIGHTS.recency * recency;
    } else {
      score = COLD_WEIGHTS.popularity * popularity + COLD_WEIGHTS.recency * recency;
    }
    return { id: c.id, creatorId: c.creatorId, score };
  });
}

const byScoreThenId = (a: Scored, b: Scored): number => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Picks the top `limit` while preventing one creator from filling the list: each creator may take at most
 * ceil(limit * 0.4) slots (at least 1) in the first pass; leftovers only fill any remaining slots afterwards.
 */
export function diversify(scored: Scored[], limit: number): Scored[] {
  const sorted = [...scored].sort(byScoreThenId);
  const cap = Math.max(1, Math.ceil(limit * 0.4));
  const perCreator = new Map<string, number>();
  const picked: Scored[] = [];
  const skipped: Scored[] = [];
  for (const s of sorted) {
    if (picked.length >= limit) break;
    const n = perCreator.get(s.creatorId) ?? 0;
    if (n >= cap) {
      skipped.push(s);
      continue;
    }
    perCreator.set(s.creatorId, n + 1);
    picked.push(s);
  }
  for (const s of skipped) {
    if (picked.length >= limit) break;
    picked.push(s);
  }
  return picked.sort(byScoreThenId);
}

export function recommend(req: AiRecommendRequest): Array<{ id: string; score: number }> {
  return diversify(scoreCandidates(req), req.limit).map((s) => ({ id: s.id, score: Math.round(s.score * 1e6) / 1e6 }));
}

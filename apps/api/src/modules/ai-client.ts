import { aiRecommendResponse, type AiRecommendRequest, type AiRecommendResponse } from '@tesor_gp/shared';

type State = 'closed' | 'open' | 'half-open';

/** Opens after `threshold` consecutive failures; half-opens after `resetMs`, allowing a single probe. */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;

  constructor(
    private readonly threshold = 5,
    private readonly resetMs = 30_000,
    private readonly clock: () => number = Date.now,
  ) {}

  get state(): State {
    if (this.failures < this.threshold) return 'closed';
    return this.clock() - this.openedAt >= this.resetMs ? 'half-open' : 'open';
  }

  /** Returns true if a call may proceed. */
  tryAcquire(): boolean {
    const s = this.state;
    if (s === 'closed') return true;
    if (s === 'half-open' && !this.probing) {
      this.probing = true;
      return true;
    }
    return false;
  }

  success(): void {
    this.failures = 0;
    this.probing = false;
  }

  failure(): void {
    this.failures += 1;
    this.probing = false;
    if (this.failures >= this.threshold) this.openedAt = this.clock();
  }
}

export interface AiClient {
  recommend(request: AiRecommendRequest): Promise<AiRecommendResponse | null>;
  health(): Promise<boolean>;
  readonly breaker: CircuitBreaker;
}

/** HTTP client for the AI service. Returns null (never throws) so callers can use the fallback. */
export function createAiClient(baseUrl: string | undefined, timeoutMs: number, fetchImpl: typeof fetch = fetch): AiClient {
  const breaker = new CircuitBreaker();
  // Not configured (for example the hosted image, which does not run the AI service): never wait on it.
  if (!baseUrl) return { breaker, recommend: async () => null, health: async () => false };
  return {
    breaker,
    async recommend(request) {
      if (!breaker.tryAcquire()) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${baseUrl}/recommend`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`AI service responded ${res.status}`);
        const parsed = aiRecommendResponse.parse(await res.json());
        breaker.success();
        return parsed;
      } catch {
        breaker.failure();
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    async health() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 1000));
      try {
        const res = await fetchImpl(`${baseUrl}/health`, { signal: controller.signal });
        return res.ok;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

import pLimit from 'p-limit';

/**
 * Token-bucket-ish rate limiter with bounded wait. Previously this class
 * threw the moment the per-minute cap was hit, which forced the search engine
 * fallback chain to fire even for a brief burst that could have completed if
 * we waited a couple hundred milliseconds. That's a poor tradeoff — the next
 * engine in the fallback chain (browser-based) is much slower than waiting.
 *
 * New semantics:
 *  - Increment first; if we're under the cap, run immediately.
 *  - If we're at the cap, wait up to `maxWaitMs` for the window to roll over.
 *    Wake on a small timer so we don't spin.
 *  - If the cap is still pinned after `maxWaitMs`, throw — at that point the
 *    caller's fallback path is genuinely a better bet.
 */
export class RateLimiter {
  private limit: ReturnType<typeof pLimit>;
  private requestCount: number = 0;
  private lastResetTime: number = Date.now();
  private readonly maxRequestsPerMinute: number;
  private readonly resetIntervalMs: number;
  private readonly maxWaitMs: number;

  constructor(
    maxRequestsPerMinute: number = 10,
    resetIntervalMs: number = 60_000,
    maxWaitMs: number = 5_000,
  ) {
    this.maxRequestsPerMinute = maxRequestsPerMinute;
    this.resetIntervalMs = resetIntervalMs;
    this.maxWaitMs = maxWaitMs;
    this.limit = pLimit(5); // Max 5 concurrent in-flight tasks
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const start = Date.now();

    // Wait until either the window rolls over or our wait budget is exhausted.
    // We re-check every 100 ms — fine for a per-minute limit.
    while (true) {
      const now = Date.now();
      if (now - this.lastResetTime >= this.resetIntervalMs) {
        this.requestCount = 0;
        this.lastResetTime = now;
      }
      if (this.requestCount < this.maxRequestsPerMinute) {
        break;
      }
      if (now - start >= this.maxWaitMs) {
        const waitTime = this.resetIntervalMs - (now - this.lastResetTime);
        throw new Error(
          `Rate limit exceeded after waiting ${Math.round((now - start) / 1000)}s. ` +
            `Window resets in ${Math.ceil(waitTime / 1000)}s.`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    this.requestCount++;
    return this.limit(() => fn());
  }

  getStatus(): { requestCount: number; maxRequests: number; resetTime: number } {
    return {
      requestCount: this.requestCount,
      maxRequests: this.maxRequestsPerMinute,
      resetTime: this.lastResetTime + this.resetIntervalMs,
    };
  }
}

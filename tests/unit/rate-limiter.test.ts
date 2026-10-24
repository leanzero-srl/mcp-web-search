import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../../src/rate-limiter.js';

// The semantics documented in src/rate-limiter.ts: run under the cap, WAIT (bounded) at the cap for the window to
// roll over, and only throw once the wait budget is spent. (The old integration "rate limiter" suite only ran
// searches and never reached the cap.)
describe('RateLimiter', () => {
  it('runs immediately while under the per-window cap', async () => {
    const rl = new RateLimiter(3, 60_000, 50);
    const t0 = Date.now();
    expect(await Promise.all([1, 2, 3].map((n) => rl.execute(async () => n)))).toEqual([1, 2, 3]);
    expect(Date.now() - t0).toBeLessThan(100);
    expect(rl.getStatus().requestCount).toBe(3);
  });

  it('at the cap, waits for the window to roll over instead of failing', async () => {
    const rl = new RateLimiter(1, 300, 2_000);
    await rl.execute(async () => 'first');
    const t0 = Date.now();
    expect(await rl.execute(async () => 'second')).toBe('second');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
  });

  it('throws a clear error once the bounded wait is exhausted', async () => {
    const rl = new RateLimiter(1, 60_000, 250);
    await rl.execute(async () => 'only');
    await expect(rl.execute(async () => 'never')).rejects.toThrow(/Rate limit exceeded after waiting/);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { acquirePage, BrowserSetupTimeoutError } from '../../src/browser-watchdog.js';

// 2026-10-25: the shared WebKit stayed connected but newContext() never resolved, so every
// browser-fallback fetch hung to the 12 s tool timeout until the service was restarted.
function fakeBrowser(newContext: () => Promise<any>) {
  return { newContext: vi.fn(newContext), isConnected: () => true } as any;
}
function fakeContext() {
  return { newPage: vi.fn(async () => ({ id: 'page' })), close: vi.fn(async () => {}) };
}

describe('acquirePage watchdog', () => {
  it('rejects within the deadline and discards a wedged browser', async () => {
    let lateResolve: (c: any) => void = () => {};
    const wedged = fakeBrowser(() => new Promise(r => { lateResolve = r; }));
    const pool = { getBrowser: vi.fn(async () => wedged), discardSharedBrowser: vi.fn() };
    const t = Date.now();
    await expect(acquirePage(pool, {}, undefined, 50)).rejects.toBeInstanceOf(BrowserSetupTimeoutError);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(pool.discardSharedBrowser).toHaveBeenCalledTimes(1);
    // A context the wedged browser hands back later is closed, not leaked.
    const late = fakeContext();
    lateResolve(late);
    await new Promise(r => setTimeout(r, 10));
    expect(late.close).toHaveBeenCalled();
  });

  it('the next call uses the relaunched browser and succeeds', async () => {
    const wedged = fakeBrowser(() => new Promise(() => {}));
    const ctx = fakeContext();
    const fresh = fakeBrowser(async () => ctx);
    let current = wedged;
    const pool = {
      getBrowser: vi.fn(async () => current),
      discardSharedBrowser: vi.fn(() => { current = fresh; }),
    };
    await expect(acquirePage(pool, {}, undefined, 50)).rejects.toThrow(/newContext/);
    const got = await acquirePage(pool, {}, undefined, 50);
    expect(got.browser).toBe(fresh);
    expect(got.page).toEqual({ id: 'page' });
  });

  it('closes the context when setup throws, without discarding a healthy browser', async () => {
    const ctx = fakeContext();
    const pool = { getBrowser: vi.fn(async () => fakeBrowser(async () => ctx)), discardSharedBrowser: vi.fn() };
    await expect(acquirePage(pool, {}, async () => { throw new Error('boom'); }, 1000)).rejects.toThrow('boom');
    expect(ctx.close).toHaveBeenCalled();
    expect(pool.discardSharedBrowser).not.toHaveBeenCalled();
  });
});

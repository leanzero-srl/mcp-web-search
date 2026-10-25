import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';

/**
 * 2026-10-25: the shared WebKit browser wedged after ~1 h idle. It stayed
 * `isConnected()`, but `newContext()` never resolved, so every browser-fallback
 * fetch (example.com among them) hung until the 12 s tool timeout, forever, while
 * a freshly launched WebKit on the same box did the same fetch in 1.2 s.
 * Nothing in the setup path had a deadline and nothing ever replaced the browser.
 *
 * acquirePage() puts the whole setup (get browser, new context, new page) under
 * one deadline. On a miss it tells the pool to discard the shared browser, so the
 * NEXT call launches a fresh one instead of queueing behind the wedged one.
 */

export class BrowserSetupTimeoutError extends Error {
  constructor(step: string, ms: number) {
    super(`Browser setup timed out at "${step}" after ${ms}ms (browser discarded, next call relaunches)`);
    this.name = 'BrowserSetupTimeoutError';
  }
}

export interface PagePool {
  getBrowser(): Promise<Browser>;
  discardSharedBrowser(reason: string): Promise<void> | void;
}

export interface AcquiredPage {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export function browserSetupTimeoutMs(): number {
  const v = parseInt(process.env.BROWSER_SETUP_TIMEOUT_MS || '5000', 10);
  return Number.isFinite(v) && v > 0 ? v : 5000;
}

export async function acquirePage(
  pool: PagePool,
  contextOptions: BrowserContextOptions,
  setup?: (context: BrowserContext) => Promise<void>,
  deadlineMs: number = browserSetupTimeoutMs(),
): Promise<AcquiredPage> {
  let step = 'getBrowser';
  let timedOut = false;
  let context: BrowserContext | null = null;

  const work = (async () => {
    const browser = await pool.getBrowser();
    step = 'newContext';
    context = await browser.newContext(contextOptions);
    if (timedOut) throw new Error('late');
    if (setup) { step = 'setup'; await setup(context); }
    step = 'newPage';
    const page = await context.newPage();
    if (timedOut) throw new Error('late');
    return { browser, context, page };
  })();

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new BrowserSetupTimeoutError(step, deadlineMs));
    }, deadlineMs);
  });

  try {
    return await Promise.race([work, deadline]);
  } catch (err) {
    if (timedOut) {
      console.error(`[BrowserWatchdog] ${(err as Error).message}`);
      // Whatever the wedged browser eventually hands back must not leak.
      work.then(r => r.context.close().catch(() => {}), () => {
        const c = context as BrowserContext | null;
        if (c) c.close().catch(() => {});
      });
      try { await pool.discardSharedBrowser(`setup timeout at ${step}`); } catch { /* best effort */ }
    } else {
      const c = context as BrowserContext | null;
      if (c) await c.close().catch(() => {});
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

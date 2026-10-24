import { describe, it, expect } from 'vitest';
import { RequestDeduplicator } from '../../src/request-deduplicator.js';
import { requestContext } from '../../src/request-context.js';

// 2026-10-24: a keyed search reused an unkeyed caller's result for the same query.
describe('RequestDeduplicator caller scope', () => {
  it('does not share results between callers with different Serper keys', async () => {
    const d = new RequestDeduplicator({ maxAgeMs: 30000 });
    let calls = 0;
    const fn = (tag: string) => () => { calls++; return Promise.resolve(tag); };
    const a = await requestContext.run({}, () => d.deduplicate('jira', 'search', fn('none')));
    const b = await requestContext.run({ serperKey: 'k1' }, () => d.deduplicate('jira', 'search', fn('k1')));
    expect(a).toBe('none');
    expect(b).toBe('k1');
    expect(calls).toBe(2);
  });

  it('still dedupes the same caller', async () => {
    const d = new RequestDeduplicator({ maxAgeMs: 30000 });
    let calls = 0;
    const fn = () => { calls++; return new Promise<string>(r => setTimeout(() => r('x'), 20)); };
    const [x, y] = await requestContext.run({ serperKey: 'k1', tenantId: 't' }, () =>
      Promise.all([d.deduplicate('jira', 'search', fn), d.deduplicate('jira', 'search', fn)]));
    expect([x, y]).toEqual(['x', 'x']);
    expect(calls).toBe(1);
  });
});

// 2026-10-24: get-single-web-page-content with maxContentLength 1000 followed, within 30 s, by the same URL with
// maxContentLength 0 (no limit) returned the 1000-char page — the key ignored every option but the URL.
describe('RequestDeduplicator option and failure handling', () => {
  it('different operations (options encoded in the operation) do not share a result', async () => {
    const d = new RequestDeduplicator({ maxAgeMs: 30000 });
    const a = await d.deduplicate('https://x.test/p', 'extract|max=1000', () => Promise.resolve('short'), { caseSensitive: true });
    const b = await d.deduplicate('https://x.test/p', 'extract|max=0', () => Promise.resolve('full'), { caseSensitive: true });
    expect([a, b]).toEqual(['short', 'full']);
  });

  it('case-sensitive keys keep URLs that differ only in case apart', async () => {
    const d = new RequestDeduplicator({ maxAgeMs: 30000 });
    const a = await d.deduplicate('https://x.test/Page', 'extract', () => Promise.resolve('upper'), { caseSensitive: true });
    const b = await d.deduplicate('https://x.test/page', 'extract', () => Promise.resolve('lower'), { caseSensitive: true });
    expect([a, b]).toEqual(['upper', 'lower']);
  });

  it('a failed request is not replayed to the next caller', async () => {
    const d = new RequestDeduplicator({ maxAgeMs: 30000 });
    await expect(d.deduplicate('q', 'search', () => Promise.reject(new Error('transient')))).rejects.toThrow('transient');
    await new Promise((r) => setTimeout(r, 0));
    expect(await d.deduplicate('q', 'search', () => Promise.resolve('ok'))).toBe('ok');
  });
});

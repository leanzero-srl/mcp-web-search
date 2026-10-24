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

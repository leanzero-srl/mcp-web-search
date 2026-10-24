import { describe, it, expect } from 'vitest';
import { SearchEngine } from '../../src/search-engine.js';

// The hosted server is keyless: each caller brings its own Serper key. The circuit breaker used to be ONE
// process-wide state, so 5 failed calls with one caller's bad/exhausted key switched Serper off for every tenant.
describe('Serper circuit breaker is per key', () => {
  it("one key's failures never open the breaker for another key", () => {
    const bad = 'bad-key-' + Math.random();
    const good = 'good-key-' + Math.random();
    for (let i = 0; i < 10; i++) SearchEngine.serperBreakerRecordFailure(bad);
    expect(SearchEngine.serperBreakerShouldSkip(bad)).toBe(true);
    expect(SearchEngine.serperBreakerShouldSkip(good)).toBe(false);
  });

  it('a success resets that key', () => {
    const k = 'reset-key-' + Math.random();
    for (let i = 0; i < 10; i++) SearchEngine.serperBreakerRecordFailure(k);
    SearchEngine.serperBreakerRecordSuccess(k);
    expect(SearchEngine.serperBreakerShouldSkip(k)).toBe(false);
  });
});

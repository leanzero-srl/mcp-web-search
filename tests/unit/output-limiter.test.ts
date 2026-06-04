import { describe, it, expect } from 'vitest';
import { OutputLimiter } from '../../src/enterprise-guardrails.js';

// The OutputLimiter is the final safety net every tool response funnels through
// (via the server's respondText). It must pass small responses unchanged and,
// when it does truncate, leave an actionable pointer to read-cached-document
// rather than a silent mid-content cut.
describe('OutputLimiter', () => {
  it('returns content unchanged when under the cap', () => {
    const limiter = new OutputLimiter(1000);
    const text = 'short content';
    expect(limiter.truncate(text)).toBe(text);
    expect(limiter.needsTruncation(text)).toBe(false);
  });

  it('truncates over-cap content and appends an actionable note', () => {
    const limiter = new OutputLimiter(100);
    const text = 'x'.repeat(500);
    const out = limiter.truncate(text);

    // Body is capped at the limit, then the note is appended.
    expect(out.startsWith('x'.repeat(100))).toBe(true);
    expect(out).toContain('truncated');
    expect(out).toContain('read-cached-document');
    expect(limiter.needsTruncation(text)).toBe(true);
  });
});

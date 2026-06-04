import { describe, it, expect } from 'vitest';
import { clampReadWindow } from '../../src/utils.js';

// clampReadWindow is the pagination core behind read-cached-document. Before it,
// a saved spec/research file larger than 200KB was unreadable past its first
// page; these lock in the windowing + "Next offset" math.
describe('clampReadWindow', () => {
  const raw = 'abcdefghij'; // 10 chars

  it('returns the first page from offset 0 and reports more remaining', () => {
    const w = clampReadWindow(raw, 0, 4);
    expect(w.body).toBe('abcd');
    expect(w.start).toBe(0);
    expect(w.end).toBe(4);
    expect(w.totalLen).toBe(10);
    expect(w.hasMore).toBe(true);
  });

  it('continues from a mid-document offset; next offset === end', () => {
    const w1 = clampReadWindow(raw, 0, 4); // abcd, end 4
    const w2 = clampReadWindow(raw, w1.end, 4); // efgh, end 8
    expect(w2.body).toBe('efgh');
    expect(w2.start).toBe(4);
    expect(w2.end).toBe(8);
    expect(w2.hasMore).toBe(true);

    const w3 = clampReadWindow(raw, w2.end, 4); // ij, end 10
    expect(w3.body).toBe('ij');
    expect(w3.end).toBe(10);
    expect(w3.hasMore).toBe(false);
  });

  it('clamps an offset at or beyond EOF to an empty final page', () => {
    const atEof = clampReadWindow(raw, 10, 50);
    expect(atEof.body).toBe('');
    expect(atEof.start).toBe(10);
    expect(atEof.end).toBe(10);
    expect(atEof.hasMore).toBe(false);

    const beyond = clampReadWindow(raw, 999, 50);
    expect(beyond.body).toBe('');
    expect(beyond.start).toBe(10);
    expect(beyond.hasMore).toBe(false);
  });

  it('returns the whole string when maxChars exceeds the remainder', () => {
    const w = clampReadWindow(raw, 0, 1000);
    expect(w.body).toBe(raw);
    expect(w.hasMore).toBe(false);
  });

  it('clamps negative/garbage inputs rather than producing a bad range', () => {
    const neg = clampReadWindow(raw, -5, 3);
    expect(neg.start).toBe(0);
    expect(neg.body).toBe('abc');

    const nanMax = clampReadWindow(raw, 0, Number.NaN);
    expect(nanMax.body.length).toBeGreaterThanOrEqual(1);
  });

  it('handles an empty document', () => {
    const w = clampReadWindow('', 0, 100);
    expect(w.body).toBe('');
    expect(w.totalLen).toBe(0);
    expect(w.hasMore).toBe(false);
  });
});

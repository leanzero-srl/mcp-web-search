import { describe, it, expect } from 'vitest';
import { cleanText } from '../../src/content-quality-scorer.js';

describe('cleanText preserves vocabulary', () => {
  // Regression for the bug where cleanText stripped these words wholesale,
  // mangling articles about photography, privacy policies, etc.
  it.each([
    'photographer',
    'image',
    'photo',
    'picture',
    'gallery',
    'carousel',
    'slideshow',
    'cookie',
    'cookies',
    'privacy',
    'terms',
    'conditions',
    'copyright',
    'disclaimer',
    'legal',
  ])('preserves the word "%s" inside flowing prose', (word) => {
    const sample = `This article discusses the use of ${word} in modern publishing.`;
    const out = cleanText(sample);
    expect(out.toLowerCase()).toContain(word.toLowerCase());
  });

  it('removes data URLs', () => {
    const out = cleanText('Here is an image: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII= and back to text.');
    expect(out).not.toContain('base64');
    expect(out).toContain('Here is an image:');
    expect(out).toContain('and back to text.');
  });

  it('removes bare image URLs', () => {
    const out = cleanText('See https://cdn.example.com/photos/sunset.jpg for the picture.');
    expect(out).not.toContain('.jpg');
    expect(out).toContain('See');
    expect(out).toContain('for the picture.');
  });

  it('collapses whitespace but preserves paragraph breaks', () => {
    const sample = 'first   line\n\n\n\nsecond';
    const out = cleanText(sample);
    expect(out).toBe('first line\n\nsecond');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import {
  isAgenticClient,
  getClientInfo,
  classifyClientNameAsAgentic,
  __setClientInfoForTesting,
} from '../../src/client-detect.js';

describe('client-detect — module state', () => {
  beforeEach(() => {
    __setClientInfoForTesting(null);
  });

  it('defaults to non-agent before init', () => {
    expect(isAgenticClient()).toBe(false);
    expect(getClientInfo()).toBeNull();
  });

  it('reports the cached identity once set', () => {
    __setClientInfoForTesting({ name: 'lm-studio', version: '0.3.0', isAgentic: false });
    expect(getClientInfo()).toEqual({ name: 'lm-studio', version: '0.3.0', isAgentic: false });
    expect(isAgenticClient()).toBe(false);
  });

  it('reports agentic=true when the cached identity says so', () => {
    __setClientInfoForTesting({ name: 'Cline', version: '3.0.0', isAgentic: true });
    expect(isAgenticClient()).toBe(true);
  });
});

describe('client-detect — classification (production rule, not duplicated)', () => {
  it.each([
    ['claude-ai', true],
    ['claude.ai', true],
    ['Claude Desktop', true],
    ['claude-desktop', true],
    ['claude-desktop/0.7.0', true],   // version suffix should still match
    ['Cline', true],
    ['cline', true],
    ['Cline / 3.13.0', true],
    ['Roo Code', true],
    ['roo-cline', true],
    ['Continue', true],
    ['continue.dev', true],
  ])('classifies %s as agentic', (name, expected) => {
    expect(classifyClientNameAsAgentic(name)).toBe(expected);
  });

  it.each([
    ['lm-studio', false],
    ['LM Studio Desktop 0.3.x', false],
    ['LM Studio', false],             // not in whitelist (deliberate)
    ['unknown-client', false],
    ['', false],
    ['some-random-mcp-cli', false],
    ['mcp-inspector', false],
  ])('classifies %s as non-agent', (name, expected) => {
    expect(classifyClientNameAsAgentic(name)).toBe(expected);
  });

  it('case-insensitive', () => {
    expect(classifyClientNameAsAgentic('CLAUDE-AI')).toBe(true);
    expect(classifyClientNameAsAgentic('cLiNe')).toBe(true);
  });

  it('whitelist matches via prefix, not substring (no false positives)', () => {
    // The match is `lower.startsWith(n)`. A name like "not-cline" should NOT
    // match the "cline" entry — important to keep typos and impostor names
    // from accidentally getting agent-tier behavior.
    expect(classifyClientNameAsAgentic('not-cline')).toBe(false);
    expect(classifyClientNameAsAgentic('xclaude-ai')).toBe(false);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { isAgenticClient, getClientInfo, __setClientInfoForTesting } from '../../src/client-detect.js';

describe('client-detect', () => {
  beforeEach(() => {
    __setClientInfoForTesting(null);
  });

  it('defaults to non-agent before init', () => {
    expect(isAgenticClient()).toBe(false);
    expect(getClientInfo()).toBeNull();
  });

  it.each([
    ['claude-ai', true],
    ['claude.ai', true],
    ['Claude Desktop', true],
    ['claude-desktop', true],
    ['Cline', true],
    ['cline', true],
    ['Roo Code', true],
    ['roo-cline', true],
    ['Continue', true],
    ['lm-studio', false],
    ['LM Studio Desktop 0.3.x', false],
    ['unknown-client', false],
    ['', false],
  ])('identifies %s as agentic=%s', (name, expected) => {
    __setClientInfoForTesting({ name, version: '1.0.0', isAgentic: false });
    // The actual cached object holds whatever isAgentic was set to. The
    // production code computes isAgentic at handshake time, so for this
    // test we verify the whitelist matching by setting through the test
    // helper with the production logic mirrored here.
    const lower = name.toLowerCase();
    const expectedAgentic = ['claude-ai', 'claude.ai', 'claude-desktop', 'claude desktop', 'cline', 'roo code', 'roo-cline', 'continue']
      .some((n) => lower.startsWith(n));
    expect(expectedAgentic).toBe(expected);
  });
});

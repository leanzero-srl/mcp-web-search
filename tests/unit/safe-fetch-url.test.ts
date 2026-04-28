import { describe, it, expect } from 'vitest';
import { safeFetchUrl } from '../../src/utils.js';

describe('safeFetchUrl SSRF guard', () => {
  it.each([
    'http://169.254.169.254/latest/meta-data/', // AWS metadata
    'http://127.0.0.1:6379',                    // loopback
    'http://10.0.0.1',                          // RFC1918
    'http://192.168.1.1',                       // RFC1918
    'http://172.16.0.1',                        // RFC1918
    'http://[::1]',                             // IPv6 loopback
    'http://localhost',                          // localhost hostname
    'http://machine.local',                     // .local TLD
  ])('refuses private/reserved address: %s', async (url) => {
    await expect(safeFetchUrl(url)).rejects.toThrow(/Refused to fetch|Invalid URL/);
  });

  it.each([
    'file:///etc/passwd',
    'gopher://example.com',
    'ftp://example.com',
    'javascript:alert(1)',
  ])('refuses non-http(s) scheme: %s', async (url) => {
    await expect(safeFetchUrl(url)).rejects.toThrow(/Invalid URL/);
  });

  it.each([
    'https://example.com',
    'https://www.serper.dev/search',
    'https://api.github.com/repos/foo/bar',
  ])('accepts ordinary public URL: %s', async (url) => {
    await expect(safeFetchUrl(url)).resolves.toBeUndefined();
  });
});

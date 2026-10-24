import { describe, it, expect } from 'vitest';
import { createGitHubAxiosClient } from '../../src/github-extractor.js';

// Regression: a "token masking" request interceptor rewrote the Authorization
// header to `token ***<last 8>***` BEFORE the request was sent, so every
// GitHub call made with GITHUB_TOKEN set got HTTP 401 from api.github.com.
describe('GitHub client sends the real token', () => {
  it('Authorization on the wire is the caller-supplied header, unmodified', async () => {
    const token = 'ghp_test0123456789abcdefTOKEN';
    const client = createGitHubAxiosClient(token);
    let seen: unknown;
    await client.get('https://api.github.com/repos/o/r', {
      headers: { Authorization: `token ${token}` },
      adapter: async (config) => {
        seen = config.headers?.Authorization;
        return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
      },
    });
    expect(seen).toBe(`token ${token}`);
  });
});

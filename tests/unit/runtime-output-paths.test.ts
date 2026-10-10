/**
 * Runtime output stays inside the repo's git-ignored folders (2026-10-10).
 *
 * Before: the stdio/default fallbacks resolved one or two levels ABOVE the
 * repo. The default crawl cache was `<module dir>/../../docs/technical`, and in
 * the ESM build the module dir falls back to the cwd, so every server start from
 * the repo created ~/Projects/docs/technical and every stdio get-openapi-spec
 * saved specs there. The CJS bundle's doc root was `path.resolve(dist, '..',
 * '..')` = the repo's PARENT, which is how research reports landed in
 * mcp-web-search-upd/docs. No .gitignore can cover a folder outside the repo;
 * 31 such files were archived to ~/Library/Application Support/mcp-web-search/
 * archive/pre-confinement-2026-10-10.
 *
 * Env is cleared BEFORE the modules are imported (both read it at load).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

delete process.env.OUTPUT_DIR;
delete process.env.DOC_OUTPUT_DIR;
delete process.env.CRAWL_CACHE_DIR;

const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const inRepo = (p: string): boolean => p === REPO || p.startsWith(REPO + path.sep);
const ignored = (rel: string): boolean => {
  try {
    execFileSync('git', ['-C', REPO, 'check-ignore', '--no-index', '-q', rel]);
    return true;
  } catch {
    return false;
  }
};

const origCwd = process.cwd();
const TMP = mkdtempSync(path.join(tmpdir(), 'mcp-ws-paths-'));
afterAll(() => {
  process.chdir(origCwd);
  rmSync(TMP, { recursive: true, force: true });
});

describe('stdio runtime output lands inside the repo', () => {
  it('the default crawl cache (OpenAPI specs + index) is <repo>/docs/technical, not above the repo', async () => {
    process.chdir(REPO);
    const { crawlCache } = await import('../../src/crawl-cache.js');
    const dir = (crawlCache as unknown as { cacheDir: string }).cacheDir;
    expect(inRepo(dir), `default crawl cache dir ${dir} is outside ${REPO}`).toBe(true);
    expect(dir).toBe(path.join(REPO, 'docs', 'technical'));
  });

  it('the doc root, launched from a folder that is not a project, never climbs above the repo', async () => {
    const { getDocRoot } = await import('../../src/doc-root.js');
    process.chdir(TMP);
    try {
      const root = getDocRoot();
      // CJS (bundle / vitest): the repo itself. ESM build: the caller's cwd by design.
      expect([REPO, TMP].includes(root), `doc root ${root} is neither the repo nor the caller's cwd`).toBe(true);
    } finally {
      process.chdir(origCwd);
    }
  });
});

describe('the repo .gitignore covers every runtime output path', () => {
  it.each([
    'docs/research-output/research-2026-10-10T00-00-00-https---example-com.md',
    'docs/technical/openapi/petstore.swagger.io-swagger-petstore.json',
    'docs/technical/crawl-cache.json',
    'logs/insights.jsonl',
    'tenants.json',
  ])('%s is ignored', (rel) => {
    expect(ignored(rel), `${rel} is not git-ignored`).toBe(true);
  });

  it('no runtime output is tracked in git (a tracked file defeats the ignore rule)', () => {
    const tracked = execFileSync('git', ['-C', REPO, 'ls-files', 'docs/research-output', 'docs/technical', 'logs'], { encoding: 'utf8' }).trim();
    expect(tracked, `tracked runtime files:\n${tracked}`).toBe('');
  });
});

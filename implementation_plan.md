# Implementation Plan

[Overview]
This plan addresses two critical issues with the web search MCP server: (1) single page content extraction tool frequently times out, and (2) overall performance is too slow (>10 seconds). The solution involves fundamental architectural improvements including switching to a faster browser engine (WebKit), implementing browser context pooling for reuse instead of launching fresh browsers, enabling parallel search attempts, and optimizing the content extraction logic with quality scoring.

[Types]
New types to support browser engine optimization and context management:

```typescript
// Browser engine configuration
export type BrowserEngineType = 'webkit' | 'chromium' | 'firefox';
export type HeadlessMode = 'new' | 'legacy' | 'shell';

// Context pool settings
export interface ContextPoolConfig {
  maxSize: number;
  reuseTimeoutMs: number;
  maxAgeMs: number;
}

// Browser engine options
export interface BrowserEngineOptions {
  engineType: BrowserEngineType;
  headlessMode: HeadlessMode;
  args?: string[];
  contextPoolConfig: ContextPoolConfig;
}

// Content quality result
export interface ContentQualityResult {
  content: string;
  score: number;        // 0-1 quality score
  isValid: boolean;     // Passes minimum threshold
  wordCount: number;
}
```

[Files]
**New Files to Create:**
- `mcp-web-search/src/browser-engine.ts` - Browser engine selection with WebKit preference, Chromium new headless mode support
- `mcp-web-search/src/context-pool.ts` - Browser context pooling for reuse across requests
- `mcp-web-search/src/content-quality-scorer.ts` - Content quality assessment before returning results

**Files to Modify:**
- `mcp-web-search/src/browser-pool.ts` - Convert from full browser pooling to context pooling
- `mcp-web-search/src/search-engine.ts` - Parallel engine attempts, WebKit-first approach
- `mcp-web-search/src/enhanced-content-extractor.ts` - Quality scoring, better content extraction with Playwright locators

**Files to Delete/Move:**
- None (all modifications are additive/refactoring)

[Functions]

**New Functions:**

| Function | File | Signature | Purpose |
|----------|------|-----------|---------|
| `createOptimizedBrowser` | browser-engine.ts | `(options?: BrowserEngineOptions) => Promise<Browser>` | Launches optimized browser with new headless mode |
| `getBestContentSelector` | content-quality-scorer.ts | `(html: string) => string` | Dynamically selects best content selector for a page |
| `scoreContentQuality` | content-quality-scorer.ts | `(content: string, query?: string) => ContentQualityResult` | Assesses content quality and validity |

**Modified Functions:**

| Function | File | Changes |
|----------|------|---------|
| `SearchEngine.search()` | search-engine.ts | Change from sequential to parallel engine attempts; WebKit first, then Chromium new headless |
| `BrowserPool.getBrowser()` | browser-pool.ts | Return context instead of full browser; implement context reuse logic |
| `EnhancedContentExtractor.extractContent()` | enhanced-content-extractor.ts | Add content quality scoring; use Playwright locators for better extraction |

**Removed Functions:**
- None

[Dependencies]
No new npm packages required. All improvements use existing dependencies:
- `playwright` - Already at v1.48.0, supports all needed features
- `cheerio` - For HTML parsing (no changes needed)
- `axios` - For fallback HTTP requests (no changes needed)

**Configuration Updates:**
Add to README.md:
```markdown
## Performance Optimization

Environment variables for performance tuning:

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSER_ENGINE` | webkit | Browser engine: webkit, chromium, firefox |
| `HEADLESS_MODE` | new | Headless mode: new, legacy, shell |
| `PARALLEL_SEARCH` | true | Enable parallel search attempts |
| `CONTEXT_REUSE_ENABLED` | true | Reuse browser contexts |
| `MIN_CONTENT_LENGTH` | 200 | Minimum content length for valid results |
```

[Testing]
**Test File Updates Required:**

1. Update existing tests to use new browser engine configuration
2. Add performance benchmarks:
   - Test search time with parallel attempts vs sequential
   - Test single page extraction timeout handling
3. Add content quality validation tests

**Validation Strategy:**
- Verify WebKit browser launches successfully
- Confirm parallel search returns faster results than sequential
- Validate single page tool no longer times out on valid pages
- Check that content quality scoring filters low-quality results

[Implementation Order]

1. **Create `src/content-quality-scorer.ts`** - Implement content quality assessment logic with minimum length validation and relevance scoring

2. **Create `src/browser-engine.ts`** - Implement optimized browser launching with WebKit preference, Chromium new headless mode support (`channel: 'chromium'`), and proper cleanup

3. **Create `src/context-pool.ts`** - Implement context pooling for reuse across requests (replaces full browser launches)

4. **Modify `src/browser-pool.ts`** - Convert to context-based pooling, update return types to BrowserContext instead of Browser

5. **Modify `src/search-engine.ts`**:
   - Add parallel search attempts using `Promise.race()`
   - Change default engine from Chromium to WebKit
   - Implement WebKit → Chromium new headless fallback chain

6. **Modify `src/enhanced-content-extractor.ts`**:
   - Integrate content quality scoring
   - Use Playwright's `getByText()` and locator filtering for better extraction
   - Add minimum content length validation (200 chars)

7. **Update tests** to verify new functionality

8. **Build and validate** with existing test suite

9. **Performance testing** - Run benchmarks comparing old vs new implementation

10. **Documentation update** in README.md with new environment variables and performance expectations
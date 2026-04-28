import axios from 'axios';
import * as cheerio from 'cheerio';
import { SearchOptions, SearchResult, SearchResultWithMetadata } from './types.js';
import { generateTimestamp, sanitizeQuery, getAxiosHttpAgentConfig } from './utils.js';
import { RateLimiter } from './rate-limiter.js';
import { browserPool } from './browser-pool.js';

// Import WebKit-first browser engine
import { createOptimizedBrowser, getEnginePriorityOrder, BrowserEngineType, getEnvironmentConfig } from './browser-engine.js';
import pLimit from 'p-limit';

// Import semantic cache for result caching
import { semanticCache } from './semantic-cache.js';

// Import request deduplicator to prevent duplicate concurrent API calls
import { requestDeduplicator } from './request-deduplicator.js';

export interface SearchEngineConfig {
  maxRequestsPerMinute?: number;
  resetIntervalMs?: number;
  maxConcurrentSearches?: number;
}

export class SearchEngine {
  private readonly rateLimiter: RateLimiter;
  private readonly browserPool = browserPool;
  private readonly concurrencyLimiter: ReturnType<typeof pLimit>;

  constructor(config: SearchEngineConfig = {}) {
    const {
      maxRequestsPerMinute = 50,
      resetIntervalMs = 60000,
      maxConcurrentSearches = 3
    } = config;

    this.rateLimiter = new RateLimiter(maxRequestsPerMinute, resetIntervalMs);
    this.concurrencyLimiter = pLimit(maxConcurrentSearches);

    console.log(`[SearchEngine] Using WebKit-first engine priority: ${getEnginePriorityOrder().join(' -> ')}`);
  }

  async search(options: SearchOptions): Promise<SearchResultWithMetadata> {
    const { query, numResults = 5, timeout = 10000 } = options;
    const sanitizedQuery = sanitizeQuery(query);

    console.log(`[SearchEngine] Starting search for query: "${sanitizedQuery}"`);

    // OPTIMIZATION 1: Check semantic cache FIRST, before any rate limiting or concurrency overhead
    const cacheEnabled = process.env.SEMANTIC_CACHE_ENABLED !== 'false';
    if (cacheEnabled) {
      const cached = await semanticCache.get(sanitizedQuery);
      if (cached && Array.isArray(cached.results) && cached.results.length > 0) {
        console.log(`[SearchEngine] ⚡ Cache HIT for query: "${sanitizedQuery}" - returning immediately`);
        return {
          results: cached.results as SearchResult[],
          engine: 'semantic-cache',
          total_results: cached.results.length
        };
      }
    }

    // OPTIMIZATION 3: Deduplicate concurrent identical search requests
    // This prevents duplicate API/browser calls when the same query arrives simultaneously
    return requestDeduplicator.deduplicate(
      sanitizedQuery,
      'search',
      () => this.executeSearch(sanitizedQuery, numResults, timeout)
    );
  }

  /**
   * Executes the actual search logic (wrapped by deduplication in search())
   *
   * Mode selection (Serper-first by default — README documents
   * `USE_SERPER_ONLY=true` and the user has confirmed Serper is the right
   * primary path):
   *   - `USE_SERPER_ONLY=false` ⇒ enable browser fallbacks
   *   - `ENABLE_BROWSER_FALLBACKS=true` ⇒ enable browser fallbacks (legacy alias)
   *   - otherwise ⇒ Serper only (skip Playwright launches entirely)
   */
  private async executeSearch(query: string, numResults: number, timeout: number): Promise<SearchResultWithMetadata> {
    const serperOnlyEnv = process.env.USE_SERPER_ONLY;
    const enableBrowserFallbacks =
      process.env.ENABLE_BROWSER_FALLBACKS === 'true' || serperOnlyEnv === 'false';
    const useSerperOnly = !enableBrowserFallbacks;

    console.log(`[SearchEngine] Serper-only mode: ${useSerperOnly} (USE_SERPER_ONLY=${serperOnlyEnv ?? 'unset'}, ENABLE_BROWSER_FALLBACKS=${process.env.ENABLE_BROWSER_FALLBACKS ?? 'unset'})`);

    // Fast path: Skip browser engines entirely for maximum performance
    if (useSerperOnly) {
      try {
        // Skip rate limiter for cache hits, but still use it for actual API calls
        const results = await this.tryApiSearch(query, numResults, timeout);
        if (results.length > 0) {
          console.log(`[SearchEngine] ✓ Serper returned ${results.length} results directly`);
          return { results, engine: 'serper-only' };
        }
      } catch (error) {
        console.error('[SearchEngine] Serper API failed:', error instanceof Error ? error.message : 'Unknown');
      }
      // If Serper fails, optionally try browser fallbacks
      if (!enableBrowserFallbacks) {
        console.log('[SearchEngine] Serper failed, but browser fallbacks disabled. Returning empty results.');
        return { results: [], engine: 'serper-failed-no-fallback' };
      }
    }

    // Only proceed to browser engines if fallbacks are enabled
    try {
      // First, respect the concurrency limit for active searches
      return await this.concurrencyLimiter(() =>
        this.rateLimiter.execute(async () => {
          // Configuration from environment variables
          const enableQualityCheck = process.env.ENABLE_RELEVANCE_CHECKING !== 'false';
          const qualityThreshold = parseFloat(process.env.RELEVANCE_THRESHOLD || '0.3');

          console.log(`[SearchEngine] Quality checking: ${enableQualityCheck}, threshold: ${qualityThreshold}`);

          // WebKit-first engine priority for parallel search
          const enginePriority: BrowserEngineType[] = getEnginePriorityOrder();
          const useParallel = process.env.PARALLEL_SEARCH !== 'false'; // Default to true

          if (useParallel) {
            console.log(`[SearchEngine] Running parallel search with engines: ${enginePriority.join(', ')}`);
            // Pass the timeout through to allow engines to respect the overall budget
            return await this.searchWithPriorityFallbacks(query, numResults, timeout, enableQualityCheck, qualityThreshold);
          } else {
            console.log(`[SearchEngine] Using sequential search fallback`);
            return await this.searchWithSequentialFallbacks(query, numResults, timeout, enableQualityCheck, qualityThreshold);
          }
        })
      );
    } catch (error) {
      console.error('[SearchEngine] Search error:', error);
      if (axios.isAxiosError(error)) {
        console.error('[SearchEngine] Axios error details:', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data?.substring(0, 500),
        });
      }
      throw new Error(`Failed to perform search: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Implements a smart parallel search strategy that avoids exhausting the browser pool.
   * Instead of launching all engines at once, it tries them in priority order,
   * only launching subsequent engines if the previous ones didn't meet quality thresholds.
   */
  /**
   * Priority-based fallback search — tries engines in order, returns first that meets quality threshold.
   * Renamed from "parallel" as it's inherently sequential (engines are tried in priority order).
   */
  private async searchWithPriorityFallbacks(
    query: string,
    numResults: number,
    timeout: number,
    enableQualityCheck: boolean,
    qualityThreshold: number
  ): Promise<SearchResultWithMetadata> {
    const startTime = Date.now();
    const enginePriority: BrowserEngineType[] = getEnginePriorityOrder();

     // Optimization: Use a reasonable fraction of the timeout, but cap it to leave room for fallbacks
     // With early return, we typically only need one engine's worth of time
     const engineTimeout = Math.min(Math.max(timeout * 0.6, 8000), timeout);

    console.log(`[SearchEngine] Starting priority fallback search (priority: ${enginePriority.join(', ')})`);

    let bestResults: SearchResult[] = [];
    let bestEngine = 'none';
    let highestQuality = -1;

    for (let i = 0; i < enginePriority.length; i++) {
      const engineType = enginePriority[i];
      console.log(`[SearchEngine] Attempting priority engine ${i + 1}/${enginePriority.length}: ${engineType}`);

      try {
        // Check if we have exceeded the overall search timeout
        const remainingTime = timeout - (Date.now() - startTime);
        if (remainingTime <= 0) {
          console.log(`[SearchEngine] Search timeout reached before attempting engine ${engineType}`);
          break;
        }

        // Optimization: Only delay if we have plenty of time left.
        // Reduced max delay to 500ms since early return should skip most browser attempts
        if (i > 0 && remainingTime > 4000) {
          const delay = Math.min(500, remainingTime / 8);
          console.log(`[SearchEngine] Throttling: waiting ${delay.toFixed(0)}ms before next engine attempt...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }

     // Use a more realistic timeout for the engine that respects the remaining budget
     const currentEngineTimeout = Math.max(Math.min(engineTimeout, remainingTime), 5000);
     const results = await this.runSearchWithEngine(engineType, query, numResults, currentEngineTimeout);

        if (results && results.length > 0) {
          const qualityScore = enableQualityCheck ? this.assessResultQuality(results, query) : 1.0;
          console.log(`[SearchEngine] Engine ${engineType} returned ${results.length} results (quality: ${qualityScore.toFixed(2)})`);

          // Track the best results found so far as a fallback
          if (qualityScore > highestQuality) {
            highestQuality = qualityScore;
            bestResults = results;
            bestEngine = `${engineType}-fallback`;
          }

          // Early return optimization: If API engine returns good results, skip browser engines
          // This avoids expensive browser launches when Serper already succeeded
          if (engineType === 'api' && qualityScore >= 0.5) {
            console.log(`[SearchEngine] API returned quality results (${qualityScore.toFixed(2)}), skipping browser engines for speed`);
            return { results, engine: `${engineType}-early-return` };
          }

          if (qualityScore >= qualityThreshold || i === enginePriority.length - 1) {
            console.log(`[SearchEngine] Smart parallel search completed in ${Date.now() - startTime}ms using ${engineType}`);
            return { results, engine: `${engineType}-priority` };
          }
          console.log(`[SearchEngine] Quality score ${qualityScore.toFixed(2)} below threshold ${qualityThreshold}, trying next engine...`);
        } else {
          console.log(`[SearchEngine] Engine ${engineType} returned no results.`);
        }
      } catch (error) {
        console.log(`[SearchEngine] Engine ${engineType} search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    if (bestResults.length > 0) {
      console.log(`[SearchEngine] All priority engines below threshold, returning best available from ${bestEngine} (quality: ${highestQuality.toFixed(2)})`);
      return { results: bestResults, engine: bestEngine };
    }

    console.log(`[SearchEngine] All priority engines exhausted in ${Date.now() - startTime}ms with no results`);
    return { results: [], engine: 'none' };
  }

  /**
   * Sequential fallback search (original behavior, kept for compatibility)
   */
  private async searchWithSequentialFallbacks(
    query: string,
    numResults: number,
    timeout: number,
    enableQualityCheck: boolean,
    qualityThreshold: number
  ): Promise<SearchResultWithMetadata> {
    // Try multiple approaches to get search results, starting with most reliable
    const approaches = [
      { method: this.tryApiSearch.bind(this), name: 'API Search' },
      { method: this.tryBrowserBingSearch.bind(this), name: 'Browser Bing' },
      { method: this.tryBrowserBraveSearch.bind(this), name: 'Browser Brave' },
      { method: this.tryDuckDuckGoSearch.bind(this), name: 'Axios DuckDuckGo' }
    ];
    
    let bestResults: SearchResult[] = [];
    let bestEngine = 'None';
    let bestQuality = 0;
    
    for (let i = 0; i < approaches.length; i++) {
      const approach = approaches[i];
      try {
        console.log(`[SearchEngine] Attempting ${approach.name} (${i + 1}/${approaches.length})...`);

        // Give API search more time (Serper can take 5-10s), browser searches get less
        const isApiSearch = approach.name === 'API Search';
        const approachTimeout = isApiSearch 
          ? Math.min(timeout * 0.6, 12000)  // API gets up to 12s or 60% of budget
          : Math.min(timeout / 4, 5000);    // Browser fallbacks get max 5s
        
        const results = await approach.method(query, numResults, approachTimeout);
        if (results.length > 0) {
          console.log(`[SearchEngine] Found ${results.length} results with ${approach.name}`);

          // Validate result quality to detect irrelevant results
          const qualityScore = enableQualityCheck ? this.assessResultQuality(results, query) : 1.0;
          console.log(`[SearchEngine] ${approach.name} quality score: ${qualityScore.toFixed(2)}/1.0`);

          // Track the best results so far
          if (qualityScore > bestQuality) {
            bestResults = results;
            bestEngine = approach.name;
            bestQuality = qualityScore;
          }

          // Early return: If API search returns good results, skip browser fallbacks entirely
          // This is the key optimization for Serper performance
          if (isApiSearch && qualityScore >= 0.5) {
            console.log(`[SearchEngine] API returned quality results (${qualityScore.toFixed(2)}), skipping browser fallbacks`);
            return { results, engine: approach.name };
          }

          // If quality is excellent, return immediately
          if (qualityScore >= 0.8) {
            console.log(`[SearchEngine] Excellent quality results from ${approach.name}, returning immediately`);
            return { results, engine: approach.name };
          }

          // If quality is acceptable and this isn't first engine, return
          if (qualityScore >= qualityThreshold && approach.name !== 'Browser Bing') {
            console.log(`[SearchEngine] Good quality results from ${approach.name}, using as primary`);
            return { results, engine: approach.name };
          }

          // If this is the last engine or quality is acceptable, prepare to return
          if (i === approaches.length - 1) {
            if (bestQuality >= qualityThreshold || !enableQualityCheck) {
              console.log(`[SearchEngine] Using best results from ${bestEngine} (quality: ${bestQuality.toFixed(2)})`);
              return { results: bestResults, engine: bestEngine };
            } else if (bestResults.length > 0) {
              console.log(`[SearchEngine] Warning: Low quality results from all engines, using best available`);
              return { results: bestResults, engine: bestEngine };
            }
          }
        }
      } catch (error) {
        console.error(`[SearchEngine] ${approach.name} approach failed:`, error);
        await this.handleBrowserError(error, approach.name);
      }
    }
    
    console.log(`[SearchEngine] All sequential approaches failed, returning empty results`);
    return { results: [], engine: 'None' };
  }

  // ---- Serper circuit breaker ------------------------------------------------
  // After N consecutive failures we stop calling Serper for `cooldownMs` and
  // let the fallback chain take over immediately. After the cooldown a single
  // probe request is allowed; on success we close, on failure we re-open.
  // Process-wide state is fine — there's typically one SearchEngine per process.
  private static serperBreaker = {
    consecutiveFailures: 0,
    openedAt: 0,
    halfOpen: false,
    failureThreshold: parseInt(process.env.SERPER_BREAKER_FAILURES || '5', 10),
    cooldownMs: parseInt(process.env.SERPER_BREAKER_COOLDOWN_MS || '30000', 10),
  };

  private static serperBreakerShouldSkip(): boolean {
    const b = SearchEngine.serperBreaker;
    if (b.openedAt === 0) return false;
    const sinceOpen = Date.now() - b.openedAt;
    if (sinceOpen >= b.cooldownMs) {
      // Allow one probe request through.
      if (!b.halfOpen) {
        b.halfOpen = true;
        return false;
      }
      // Probe is in flight — keep skipping until it resolves.
      return true;
    }
    return true;
  }

  private static serperBreakerRecordSuccess(): void {
    const b = SearchEngine.serperBreaker;
    b.consecutiveFailures = 0;
    b.openedAt = 0;
    b.halfOpen = false;
  }

  private static serperBreakerRecordFailure(): void {
    const b = SearchEngine.serperBreaker;
    b.consecutiveFailures += 1;
    b.halfOpen = false;
    if (b.consecutiveFailures >= b.failureThreshold && b.openedAt === 0) {
      b.openedAt = Date.now();
      console.error(
        `[SearchEngine] Serper circuit breaker OPENED after ${b.consecutiveFailures} ` +
          `consecutive failures; cooldown ${b.cooldownMs}ms`,
      );
    }
  }

  /**
   * Runs a search with a specific browser engine
   */
  private async tryApiSearch(query: string, numResults: number, timeout: number): Promise<SearchResult[]> {
    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) {
      console.error('[SearchEngine] API search failed: SERPER_API_KEY is not set');
      return [];
    }

    if (SearchEngine.serperBreakerShouldSkip()) {
      console.error('[SearchEngine] Serper circuit breaker OPEN — skipping API call, using fallback');
      return [];
    }

    // NOTE: Cache check has been moved to the search() method above.
    // The semanticCache.get() now handles concurrent request deduplication
    // via pendingCache - removing duplicate cache check here saves ~50ms per query.

    console.log(`[SearchEngine] Starting API-based search for: "${query}"`);
    const timestamp = generateTimestamp();

    try {
      const response = await axios.post(
        'https://google.serper.dev/search',
        {
          q: query,
          num: Math.min(numResults, 10)
        },
        {
          headers: {
            'X-API-KEY': apiKey,
            'Content-Type': 'application/json'
          },
          timeout: timeout,
          ...getAxiosHttpAgentConfig(),
        }
      );

      const organicResults = response.data.organic || [];
      console.log(`[SearchEngine] API search returned ${organicResults.length} results`);

      const results = organicResults.map((item: any) => ({
        title: item.title,
        url: item.link,
        description: item.snippet || 'No description available',
        fullContent: '',
        contentPreview: '',
        wordCount: 0,
        timestamp,
        fetchStatus: 'success',
      }));

      // Cache the results for future use (only if cache not already checked in search())
      const cacheEnabled = process.env.SEMANTIC_CACHE_ENABLED !== 'false';
      if (cacheEnabled && results.length > 0) {
        const cacheTtl = parseInt(process.env.SEMANTIC_CACHE_TTL || '3600000', 10);
        await semanticCache.set(query, results, cacheTtl);
        console.log(`[SearchEngine] Cached results for query: "${query}"`);
      }

      SearchEngine.serperBreakerRecordSuccess();
      return results;
    } catch (error) {
      SearchEngine.serperBreakerRecordFailure();
      console.error(`[SearchEngine] API search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      if (axios.isAxiosError(error)) {
        console.error('[SearchEngine] API Axios error details:', {
          status: error.response?.status,
          data: error.response?.data,
        });
      }
      return [];
    }
  }

  private async runSearchWithEngine(
    engineType: BrowserEngineType,
    query: string,
    numResults: number,
    timeout: number
  ): Promise<SearchResult[]> {
    console.log(`[SearchEngine] Starting ${engineType} search for: ${query}`);
    
    const envConfig = getEnvironmentConfig();
    let browser;
    let context;
    let isFromPool = false;

    if (engineType === 'api') {
      return await this.tryApiSearch(query, numResults, timeout);
    }

    // If engine matches the pool's configuration, use the pool to avoid expensive launches
    if (engineType === envConfig.engineType) {
      context = await this.browserPool.getContext();
      browser = context.browser();
      isFromPool = true;
    } else {
      // Fallback engines launch a dedicated browser instance
      browser = await createOptimizedBrowser({
        engineType,
        headlessMode: 'new', // Use new headless mode
      });
    }
    
    try {
      // Use appropriate search method based on engine
      if (engineType === 'webkit') {
        return await this.tryDuckDuckGoSearch(query, numResults, timeout);
      } else if (engineType === 'chromium') {
        // Use pooled browser for Bing search
        if (!browser) throw new Error('Browser not available for chromium engine');
        const page = await browser.newPage({
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          viewport: { width: 1366, height: 768 },
          locale: 'en-US',
          timezoneId: 'America/New_York',
          colorScheme: 'light',
        });
        try {
          const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout });
          try { await page.waitForSelector('#b_results .b_algo', { timeout: Math.min(timeout, 8000) }); } catch {}
          const html = await page.content();
          return this.parseBingResults(html, numResults);
        } finally { await page.close(); }
      } else if (engineType === 'firefox') {
        // Use pooled browser for Brave search
        if (!browser) throw new Error('Browser not available for firefox engine');
        const page = await browser.newPage({
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          viewport: { width: 1366, height: 768 },
          locale: 'en-US',
          timezoneId: 'America/New_York',
        });
        try {
          const searchUrl = `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`;
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout });
          try { await page.waitForSelector('[data-type="web"], .result', { timeout: Math.min(timeout, 8000) }); } catch {}
          const html = await page.content();
          return this.parseBraveResults(html, numResults);
        } finally { await page.close(); }
      }

      return [];
    } finally {
      if (isFromPool && context) {
        // Release the context back to the pool for reuse
        await this.browserPool.releaseContext(context);
      } else if (browser) {
        // For non-pooled browsers, close the instance entirely
        try {
          await browser.close();
        } catch (error) {
          console.log(`[SearchEngine] Error closing ${engineType} browser:`, error);
        }
      }
    }
  }

  private async tryBrowserBraveSearch(query: string, numResults: number, timeout: number): Promise<SearchResult[]> {
    console.log(`[SearchEngine] Trying browser-based Brave search with shared browser pool...`);

    // Try with retry mechanism
    for (let attempt = 1; attempt <= 2; attempt++) {
      let page;
      let browser;
      try {
        console.log(`[SearchEngine] Brave search attempt ${attempt}/2 with pooled browser`);

        // Use shared browser pool instead of launching a fresh browser
        const launchPromise = this.browserPool.getBrowser();
        browser = await Promise.race([
          launchPromise,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Browser launch timeout')), 15000)),
        ]);

        if (!browser.isConnected()) {
          throw new Error('Browser not connected after pool retrieval');
        }

        page = await browser.newPage({
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          viewport: { width: 1366, height: 768 },
          locale: 'en-US',
          timezoneId: 'America/New_York',
        });

        // Navigate to Brave search
        const searchUrl = `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`;
        console.log(`[SearchEngine] Browser navigating to Brave: ${searchUrl}`);

        await page.goto(searchUrl, {
          waitUntil: 'domcontentloaded',
          timeout,
        });

        // Wait for search results to load
        try {
          const dynamicTimeout = Math.min(timeout * 0.7, 10000);
          await page.waitForSelector('[data-type="web"], .result, .b_algo, .result__a, [class*="result"], [class*="web"]', {
            timeout: dynamicTimeout,
          });
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch {
          console.log(`[SearchEngine] Browser Brave results selector not found or timed out, proceeding`);
        }

        const html = await page.content();
        console.log(`[SearchEngine] Browser Brave got HTML with length: ${html.length}`);

        const results = this.parseBraveResults(html, numResults);
        console.log(`[SearchEngine] Browser Brave parsed ${results.length} results`);

        return results;
      } catch (error) {
        console.error(`[SearchEngine] Brave search attempt ${attempt}/2 failed:`, error);
        if (attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 500));
      } finally {
        // Close the page only — the browser is owned by the shared pool.
        // Closing it here would defeat pooling and force a relaunch (~1–3 s)
        // on every search.
        if (page) {
          try { await page.close(); } catch {}
        }
      }
    }

    throw new Error('All Brave search attempts failed');
  }

  private async tryBrowserBingSearch(query: string, numResults: number, timeout: number): Promise<SearchResult[]> {
    const debugBing = process.env.DEBUG_BING_SEARCH === 'true';
    console.error(`[SearchEngine] BING: Starting browser-based search with shared browser pool for query: "${query}"`);

    // Try with retry mechanism
    for (let attempt = 1; attempt <= 2; attempt++) {
      let page;
      let browser;
      try {
        console.error(`[SearchEngine] BING: Attempt ${attempt}/2 - Getting browser from pool...`);

        // Use shared browser pool instead of launching a fresh browser
        const launchPromise = this.browserPool.getBrowser();
        const startTime = Date.now();
        browser = await Promise.race([
          launchPromise,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Browser launch timeout')), 15000)),
        ]);
        const launchTime = Date.now() - startTime;

        console.error(`[SearchEngine] BING: Browser ready in ${launchTime}ms, connected: ${browser.isConnected()}`);

        page = await browser.newPage({
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          viewport: { width: 1366, height: 768 },
          locale: 'en-US',
          timezoneId: 'America/New_York',
          colorScheme: 'light',
          deviceScaleFactor: 1,
          hasTouch: false,
          isMobile: false,
          extraHTTPHeaders: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'DNT': '1',
          },
        });

        const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
        console.error(`[SearchEngine] BING: Navigating to ${searchUrl}`);

        await page.goto(searchUrl, {
          waitUntil: 'domcontentloaded',
          timeout,
        });

        // Wait for search results
        try {
          await page.waitForSelector('#b_results .b_algo, #b_context', { timeout: Math.min(timeout, 8000) });
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch {
          console.error(`[SearchEngine] BING: Results selector not found, proceeding`);
        }

        const html = await page.content();
        console.error(`[SearchEngine] BING: Got HTML with length: ${html.length}`);

        const results = this.parseBingResults(html, numResults);
        console.error(`[SearchEngine] BING: Parsed ${results.length} results`);

        return results;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[SearchEngine] BING: Attempt ${attempt}/2 FAILED: ${errorMessage}`);

        if (debugBing) console.error(`[SearchEngine] BING: Full error:`, error);

        if (attempt === 2) throw error;
        console.error(`[SearchEngine] BING: Waiting 500ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, 500));
      } finally {
        // Close the page only — browser belongs to the shared pool.
        if (page) {
          try { await page.close(); } catch {}
        }
      }
    }

    throw new Error('All Bing search attempts failed');
  }

  private async tryDuckDuckGoSearch(query: string, numResults: number, timeout: number): Promise<SearchResult[]> {
    console.log(`[SearchEngine] Trying DuckDuckGo as fallback...`);

    // Attempt 1: Fast Axios-based HTML scraping
    try {
      const response = await axios.get('https://html.duckduckgo.com/html/', {
        params: { q: query },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: Math.min(timeout, 5000),
        validateStatus: (status) => status < 400,
        ...getAxiosHttpAgentConfig(),
      });

      const results = this.parseDuckDuckGoResults(response.data, numResults);
      if (results.length > 0) {
        console.log(`[SearchEngine] DuckDuckGo Axios parsed ${results.length} results`);
        return results;
      }
      console.warn(`[SearchEngine] DuckDuckGo Axios returned 0 results, trying browser fallback...`);
    } catch (error) {
      console.warn(`[SearchEngine] DuckDuckGo Axios attempt failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Attempt 2: Robust Playwright-based search if Axios fails or returns nothing
    console.log(`[SearchEngine] Attempting robust browser-based DuckDuckGo search...`);
    try {
      // Use shared browser pool with timeout
      const launchPromise = this.browserPool.getBrowser();
      const browser = await Promise.race([
        launchPromise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Browser launch timeout')), 15000)),
      ]);

      const page = await browser.newPage({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
      });

      try {
        const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web`;
        await page.goto(searchUrl, {
          waitUntil: 'load',
          timeout: Math.min(timeout, 20000)
        });

        try {
          await page.waitForSelector('.result__a, .result, [class*="result"]', {
            timeout: Math.min(timeout * 0.8, 10000)
          });
        } catch {
          console.warn(`[SearchEngine] DuckDuckGo browser results selector not found or timed out, proceeding`);
        }

        const html = await page.content();
        const results = this.parseDuckDuckGoResults(html, numResults);
        console.log(`[SearchEngine] DuckDuckGo Browser parsed ${results.length} results`);

        return results;
      } finally {
        // Close the page only — browser belongs to the shared pool.
        try { await page.close(); } catch {}
      }
    } catch (error) {
      console.error(`[SearchEngine] DuckDuckGo browser search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw new Error('DuckDuckGo search failed');
    }
  }

   private parseBraveResults(html: string, maxResults: number): SearchResult[] {
     console.log(`[SearchEngine] Parsing Brave HTML with length: ${html.length}`);
     
     const $ = cheerio.load(html);
     const results: SearchResult[] = [];
     const timestamp = generateTimestamp();

     // Brave result selectors - expanded to be more robust
     const resultSelectors = [
       '[data-type="web"]',     // Main Brave results
       '.result',               // Alternative format
       '.fdb',                  // Brave specific format
       '[class*="result"]',     // Any class containing "result"
       '[class*="web-result"]', // Any class containing "web-result"
       'div[role="listitem"]'   // Common list item role
     ];
    
    let foundResults = false;
    
    for (const selector of resultSelectors) {
      if (foundResults && results.length >= maxResults) break;
      
      console.log(`[SearchEngine] Trying Brave selector: ${selector}`);
      const elements = $(selector);
      console.log(`[SearchEngine] Found ${elements.length} elements with selector ${selector}`);
      
      elements.each((_index, element) => {
        if (results.length >= maxResults) return false;

        const $element = $(element);
        
        // Try multiple title selectors for Brave
        const titleSelectors = [
          '.title a',              // Brave specific
          'h2 a',                  // Common format  
          '.result-title a',       // Alternative format
          'a[href*="://"]',        // Any external link
          '.snippet-title a'       // Snippet title
        ];
        
        let title = '';
        let url = '';
        
        for (const titleSelector of titleSelectors) {
          const $titleElement = $element.find(titleSelector).first();
          if ($titleElement.length) {
            title = $titleElement.text().trim();
            url = $titleElement.attr('href') || '';
            console.log(`[SearchEngine] Brave found title with ${titleSelector}: "${title}"`);
            if (title && url && url.startsWith('http')) {
              break;
            }
          }
        }
        
        // If still no title, try getting it from any text content
        if (!title) {
          const textContent = $element.text().trim();
          const lines = textContent.split('\n').filter(line => line.trim().length > 0);
          if (lines.length > 0) {
            title = lines[0].trim();
            console.log(`[SearchEngine] Brave found title from text content: "${title}"`);
          }
        }
        
        // Try multiple snippet selectors for Brave
        const snippetSelectors = [
          '.snippet-content',      // Brave specific
          '.snippet',              // Generic
          '.description',          // Alternative
          'p'                      // Fallback paragraph
        ];
        
        let snippet = '';
        for (const snippetSelector of snippetSelectors) {
          const $snippetElement = $element.find(snippetSelector).first();
          if ($snippetElement.length) {
            snippet = $snippetElement.text().trim();
            break;
          }
        }
        
        if (title && url && this.isValidSearchUrl(url)) {
          console.log(`[SearchEngine] Brave found: "${title}" -> "${url}"`);
          results.push({
            title,
            url: this.cleanBraveUrl(url),
            description: snippet || 'No description available',
            fullContent: '',
            contentPreview: '',
            wordCount: 0,
            timestamp,
            fetchStatus: 'success',
          });
          foundResults = true;
        }
      });
    }

    console.log(`[SearchEngine] Brave found ${results.length} results`);
    return results;
  }

  private parseBingResults(html: string, maxResults: number): SearchResult[] {
    console.error(`[SearchEngine] BING: Parsing HTML with length: ${html.length}`);
    
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    const timestamp = generateTimestamp();

    // Check for common Bing error indicators
    const pageTitle = $('title').text();
    console.error(`[SearchEngine] BING: Page title: "${pageTitle}"`);
    
    if (pageTitle.includes('Access Denied') || pageTitle.includes('blocked') || pageTitle.includes('captcha')) {
      console.error(`[SearchEngine] BING: ERROR - Bot detection or access denied detected in page title`);
    }

    // Bing result parsing - more robust approach
    // Instead of relying on container selectors which can be inconsistent,
    // we look for the actual result elements (h2 a is the most reliable Bing pattern)
    console.error(`[SearchEngine] BING: Starting robust parsing...`);
    
    let foundResults = false;

    // 1. Find all potential result links (h2 a is the most reliable Bing pattern)
    // We also look for other common patterns like h3 a or just any link within a result container
    const resultLinks = $('h2 a, h3 a, .b_algo a, .b_result a').toArray();
    console.error(`[SearchEngine] BING: Found ${resultLinks.length} potential result links via combined selectors`);

    for (const linkElement of resultLinks) {
      if (results.length >= maxResults) break;

      const $link = $(linkElement);
      const title = $link.text().trim();
      const url = $link.attr('href') || '';

       // Basic validation: must have title and a valid URL
       if (title && url && this.isValidSearchUrl(url)) {
         // 2. Find the snippet for this result. 
         // We look for the closest container that might hold the snippet.
        let snippet = '';
        
        // Try common Bing snippet containers relative to the title
        const $container = $link.closest('.b_algo, .b_result, .b_card, [class*="b_algo"], [class*="b_result"], .result-item, div[class*="b_algo"], div[class*="b_result"], .b_search_result, .b_item');
        
        if ($container.length) {
          const snippetSelectors = [
            '.b_caption p',
            '.b_snippet',
            '.b_descript',
            '.b_caption',
            '.b_excerpt',
            'p',
            '.b_algo_content p',
            '.b_algo_content',
            '.b_desc',
            '.b_description'
          ];

          for (const selector of snippetSelectors) {
            const $snippetElement = $container.find(selector).first();
            if ($snippetElement.length) {
              const candidateSnippet = $snippetElement.text().trim();
              // Avoid very short snippets or ones that look like timestamps/metadata
              if (candidateSnippet.length > 20 && !candidateSnippet.match(/^\d+\s*(min|sec|hour|day|week|month|year)/i)) {
                snippet = candidateSnippet;
                break;
              }
            }
          }
        } else {
          // Fallback: if no container found, try searching the whole document for a paragraph near the title
          // This is a last resort and might be less accurate.
          const $allPs = $('p');
          for (let i = 0; i < $allPs.length; i++) {
            const $p = $($allPs[i]);
            if ($p.text().trim().length > 20 && $p.text().trim().includes(title.substring(0, 10))) {
               snippet = $p.text().trim();
               break;
            }
          }
        }

        console.log(`[SearchEngine] Bing found: "${title}" -> "${url}"`);
        results.push({
          title,
          url: this.cleanBingUrl(url),
          description: snippet || 'No description available',
          fullContent: '',
          contentPreview: '',
          wordCount: 0,
          timestamp,
          fetchStatus: 'success',
        });
        foundResults = true;
      }
    }

    if (!foundResults) {
      console.error(`[SearchEngine] BING: No results found via primary selectors. Trying fallback container-based approach...`);
      // Fallback to the old selector-based approach if the primary one fails
      const fallbackSelectors = [
        '.b_algo, .b_result, [class*="b_algo"], [class*="b_result"], .b_card, .b_search_result',
        '.b_item',
        '.result-item',
        '[role="listitem"]'
      ];
      for (const selector of fallbackSelectors) {
        if (results.length >= maxResults) break;
        const elements = $(selector);
        elements.each((_index, element) => {
          if (results.length >= maxResults) return false;
          const $el = $(element);
          
          // Try multiple title/link combinations within the container
          const $titleLink = $el.find('h2 a, h3 a, .b_title a, .result-title a, a[href]').first();
          const title = $titleLink.text().trim();
          const url = $titleLink.attr('href') || '';
          
          if (title && url && this.isValidSearchUrl(url) && !url.includes('bing.com/ck/a?!&&p=')) {
             results.push({
               title,
               url: this.cleanBingUrl(url),
               description: $el.text().substring(0, 250).trim(),
               fullContent: '',
               contentPreview: '',
               wordCount: 0,
               timestamp,
               fetchStatus: 'success',
             });
             foundResults = true;
          }
        });
      }
    }

    console.log(`[SearchEngine] Bing found ${results.length} results`);
    return results;
  }

  private parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
    console.log(`[SearchEngine] Parsing DuckDuckGo HTML with length: ${html.length}`);
    
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    const timestamp = generateTimestamp();

    // DuckDuckGo results are in .result elements
    $('.result').each((_index, element) => {
      if (results.length >= maxResults) return false;

      const $element = $(element);
      
      // Extract title and URL
      const $titleElement = $element.find('.result__title a');
      const title = $titleElement.text().trim();
      const url = $titleElement.attr('href');
      
      // Extract snippet
      const snippet = $element.find('.result__snippet').text().trim();
      
      if (title && url) {
        console.log(`[SearchEngine] DuckDuckGo found: "${title}" -> "${url}"`);
        results.push({
          title,
          url: this.cleanDuckDuckGoUrl(url),
          description: snippet || 'No description available',
          fullContent: '',
          contentPreview: '',
          wordCount: 0,
          timestamp,
          fetchStatus: 'success',
        });
      }
    });

    console.log(`[SearchEngine] DuckDuckGo found ${results.length} results`);
    return results;
  }

  private isValidSearchUrl(url: string): boolean {
    // Google search results URLs can be in various formats
    return url.startsWith('/url?') ||
           url.startsWith('http://') ||
           url.startsWith('https://') ||
           url.startsWith('//') ||
           url.includes('google.com') ||
           url.length > 10; // Accept any reasonably long URL
  }

  private cleanBraveUrl(url: string): string {
    // Brave URLs are usually direct, but check for any redirect patterns
    if (url.startsWith('//')) {
      return 'https:' + url;
    }
    
    // If it's already a full URL, return as-is
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    
    return url;
  }

  private cleanBingUrl(url: string): string {
    // Bing URLs are usually direct, but check for any redirect patterns
    if (url.startsWith('//')) {
      return 'https:' + url;
    }
    
    // If it's already a full URL, return as-is
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    
    return url;
  }

  private cleanDuckDuckGoUrl(url: string): string {
    // DuckDuckGo URLs are redirect URLs that need to be decoded
    if (url.startsWith('//duckduckgo.com/l/')) {
      try {
        // Extract the uddg parameter which contains the actual URL
        const urlParams = new URLSearchParams(url.substring(url.indexOf('?') + 1));
        const actualUrl = urlParams.get('uddg');
        if (actualUrl) {
          // Decode the URL
          const decodedUrl = decodeURIComponent(actualUrl);
          console.log(`[SearchEngine] Decoded DuckDuckGo URL: ${decodedUrl}`);
          return decodedUrl;
        }
      } catch {
        console.log(`[SearchEngine] Failed to decode DuckDuckGo URL: ${url}`);
      }
    }
    
    // If it's a protocol-relative URL, add https:
    if (url.startsWith('//')) {
      return 'https:' + url;
    }
    
    return url;
  }

  private assessResultQuality(results: SearchResult[], originalQuery: string): number {
    if (results.length === 0) return 0;

    // Extract keywords from the original query (ignore common words)
    const commonWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can', 'group', 'members']);
    const queryWords = originalQuery.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !commonWords.has(word));

    if (queryWords.length === 0) return 0.5; // Default score if no meaningful keywords

    console.log(`[SearchEngine] Quality assessment - Query keywords: [${queryWords.join(', ')}]`);

    let totalScore = 0;
    let scoredResults = 0;

    for (const result of results) {
      const titleText = result.title.toLowerCase();
      const descText = result.description.toLowerCase();
      const urlText = result.url.toLowerCase();
      const combinedText = `${titleText} ${descText} ${urlText}`;

      // Count keyword matches
      let keywordMatches = 0;
      let phraseMatches = 0;

      // Check for exact phrase matches (higher value)
      if (queryWords.length >= 2) {
        const queryPhrases = queryWords.slice(0, 2).join(' ');
        if (combinedText.includes(queryPhrases)) {
          phraseMatches++;
        }
      }

      // Count keyword matches
      keywordMatches = queryWords.reduce((acc, word) => {
        return acc + (combinedText.includes(word) ? 1 : 0);
      }, 0);

      const score = (keywordMatches / queryWords.length) * 0.6 + (phraseMatches > 0 ? 0.4 : 0);
      totalScore += score;
      scoredResults++;
    }

    return scoredResults > 0 ? totalScore / scoredResults : 0;
  }

  private async handleBrowserError(error: any, engineName: string): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[SearchEngine] ${engineName} error: ${errorMessage}`);
    
    if (errorMessage.includes('context was destroyed')) {
      console.warn(`[SearchEngine] ${engineName} encountered a destroyed execution context. This is often transient.`);
    } else if (errorMessage.includes('timeout')) {
      console.warn(`[SearchEngine] ${engineName} request timed out.`);
    }
  }

  /**
   * Closes all browser instances in the pool and cleans up resources
   */
  public async closeAll(): Promise<void> {
    console.log("[SearchEngine] Closing all browser instances...");
    await this.browserPool.closeAll();
  }
}
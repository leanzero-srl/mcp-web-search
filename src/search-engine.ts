import axios from 'axios';
import * as cheerio from 'cheerio';
import { SearchOptions, SearchResult, SearchResultWithMetadata } from './types.js';
import { generateTimestamp, sanitizeQuery } from './utils.js';
import { RateLimiter } from './rate-limiter.js';
import { BrowserPool } from './browser-pool.js';

// Import WebKit-first browser engine
import { createOptimizedBrowser, getEnginePriorityOrder, BrowserEngineType, getHeadlessOption, getEnvironmentConfig } from './browser-engine.js';
import pLimit from 'p-limit';

// Import semantic cache for result caching
import { semanticCache } from './semantic-cache.js';

export interface SearchEngineConfig {
  maxRequestsPerMinute?: number;
  resetIntervalMs?: number;
  maxConcurrentSearches?: number;
}

export class SearchEngine {
  private readonly rateLimiter: RateLimiter;
  private browserPool: BrowserPool;
  private readonly concurrencyLimiter: ReturnType<typeof pLimit>;
  private readonly maxConcurrentSearches: number;

  constructor(config: SearchEngineConfig = {}) {
    const {
      maxRequestsPerMinute = 50,
      resetIntervalMs = 60000,
      maxConcurrentSearches = 3
    } = config;

    this.rateLimiter = new RateLimiter(maxRequestsPerMinute, resetIntervalMs);
    this.browserPool = new BrowserPool();
    this.maxConcurrentSearches = maxConcurrentSearches;
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
      const cached = semanticCache.get(sanitizedQuery);
      if (cached && Array.isArray(cached.results) && cached.results.length > 0) {
        console.log(`[SearchEngine] ⚡ Cache HIT for query: "${sanitizedQuery}" - returning immediately`);
        return { 
          results: cached.results as SearchResult[], 
          engine: 'semantic-cache',
          total_results: cached.results.length
        };
      }
    }

    // OPTIMIZATION 2: By default, use Serper-only mode for maximum performance
    // Browser fallbacks are opt-in via ENABLE_BROWSER_FALLBACKS=true
    const enableBrowserFallbacks = process.env.ENABLE_BROWSER_FALLBACKS === 'true';
    const useSerperOnly = !enableBrowserFallbacks;

    console.log(`[SearchEngine] Serper-only mode: ${useSerperOnly} (enableBrowserFallbacks: ${enableBrowserFallbacks})`);

    // Fast path: Skip browser engines entirely for maximum performance
    if (useSerperOnly) {
      try {
        // Skip rate limiter for cache hits, but still use it for actual API calls
        const results = await this.tryApiSearch(sanitizedQuery, numResults, timeout);
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
            return await this.searchWithParallelEngines(sanitizedQuery, numResults, timeout, enableQualityCheck, qualityThreshold);
          } else {
            console.log(`[SearchEngine] Using sequential search fallback`);
            return await this.searchWithSequentialFallbacks(sanitizedQuery, numResults, timeout, enableQualityCheck, qualityThreshold);
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
  private async searchWithParallelEngines(
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

    console.log(`[SearchEngine] Starting smart parallel search (priority: ${enginePriority.join(', ')})`);

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
            return { results, engine: `${engineType}-smart-parallel` };
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

  /**
   * Runs a search with a specific browser engine
   */
  private async tryApiSearch(query: string, numResults: number, timeout: number): Promise<SearchResult[]> {
    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) {
      console.error('[SearchEngine] API search failed: SERPER_API_KEY is not set');
      return [];
    }

    // Check cache first for repeated/similar queries
    const cacheEnabled = process.env.SEMANTIC_CACHE_ENABLED !== 'false';
    if (cacheEnabled) {
      const cached = semanticCache.get(query);
      if (cached && Array.isArray(cached.results)) {
        console.log(`[SearchEngine] Cache HIT for query: "${query}"`);
        return cached.results as SearchResult[];
      }
    }

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
          timeout: timeout
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

      // Cache the results for future use
      if (cacheEnabled && results.length > 0) {
        const cacheTtl = parseInt(process.env.SEMANTIC_CACHE_TTL || '3600000', 10);
        semanticCache.set(query, results, cacheTtl);
        console.log(`[SearchEngine] Cached results for query: "${query}"`);
      }

      return results;
    } catch (error) {
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
        return await this.tryBrowserBingSearchInternal(browser, query, numResults, timeout);
      } else if (engineType === 'firefox') {
        return await this.tryBrowserBraveSearchInternal(browser, query, numResults, timeout);
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
    console.log(`[SearchEngine] Trying browser-based Brave search with dedicated browser...`);
    
    // Try with retry mechanism
    for (let attempt = 1; attempt <= 2; attempt++) {
      let browser;
      try {
        // Create a dedicated browser instance for Brave search only
        const { firefox } = await import('playwright');
        browser = await firefox.launch({
          headless: process.env.BROWSER_HEADLESS !== 'false',
          args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
          ],
        });
        
        console.log(`[SearchEngine] Brave search attempt ${attempt}/2 with fresh browser`);
        const results = await this.tryBrowserBraveSearchInternal(browser, query, numResults, timeout);
        return results;
      } catch (error) {
        console.error(`[SearchEngine] Brave search attempt ${attempt}/2 failed:`, error);
        if (attempt === 2) {
          throw error; // Re-throw on final attempt
        }
        // Small delay before retry
        await new Promise(resolve => setTimeout(resolve, 500));
      } finally {
        // Always close the dedicated browser
        if (browser) {
          try {
            await browser.close();
          } catch (closeError) {
            console.log(`[SearchEngine] Error closing Brave browser:`, closeError);
          }
        }
      }
    }
    
    throw new Error('All Brave search attempts failed');
  }

  private async tryBrowserBraveSearchInternal(browser: any, query: string, numResults: number, timeout: number): Promise<SearchResult[]> {
    // Validate browser is still functional before proceeding
    if (!browser.isConnected()) {
      throw new Error('Browser is not connected');
    }
    
    try {
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
      });

      try {
        const page = await context.newPage();
        
        // Navigate to Brave search
        const searchUrl = `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`;
        console.log(`[SearchEngine] Browser navigating to Brave: ${searchUrl}`);
        
        await page.goto(searchUrl, { 
          waitUntil: 'domcontentloaded',
          timeout: timeout
        });

         // Wait for search results to load with dynamic timeout based on budget
         try {
           // Use more specific selectors for Brave and use dynamic timeout
           const dynamicTimeout = Math.min(timeout * 0.7, 10000);
           await page.waitForSelector('[data-type="web"], .result, .b_algo, .result__a, [class*="result"], [class*="web"]', { 
             timeout: dynamicTimeout 
           });
           // Reduced buffer for Brave's JS hydration
           await new Promise(resolve => setTimeout(resolve, 1000));
         } catch {
           console.log(`[SearchEngine] Browser Brave results selector not found or hydration timed out, proceeding anyway`);
         }

        // Get the page content
        const html = await page.content();
        
        console.log(`[SearchEngine] Browser Brave got HTML with length: ${html.length}`);
        
        const results = this.parseBraveResults(html, numResults);
        console.log(`[SearchEngine] Browser Brave parsed ${results.length} results`);
        
        await context.close();
        return results;
      } catch (error) {
        // Ensure context is closed even on error
        await context.close();
        throw error;
      }
    } catch (error) {
      console.error(`[SearchEngine] Browser Brave search failed:`, error);
      throw error;
    }
  }

  private async tryBrowserBingSearch(query: string, numResults: number, timeout: number): Promise<SearchResult[]> {
    const debugBing = process.env.DEBUG_BING_SEARCH === 'true';
    console.error(`[SearchEngine] BING: Starting browser-based search with dedicated browser for query: "${query}"`);
    
    // Try with retry mechanism
    for (let attempt = 1; attempt <= 2; attempt++) {
      let browser;
      try {
        console.error(`[SearchEngine] BING: Attempt ${attempt}/2 - Launching Chromium browser...`);
        
        // Create a dedicated browser instance for Bing search only
        const { chromium } = await import('playwright');
        const startTime = Date.now();
        browser = await chromium.launch({
          headless: process.env.BROWSER_HEADLESS !== 'false',
          args: [
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--disable-gpu',
          ],
        });
        
        const launchTime = Date.now() - startTime;
        console.error(`[SearchEngine] BING: Browser launched successfully in ${launchTime}ms, connected: ${browser.isConnected()}`);
        
        const results = await this.tryBrowserBingSearchInternal(browser, query, numResults, timeout);
        console.error(`[SearchEngine] BING: Search completed successfully with ${results.length} results`);
        return results;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[SearchEngine] BING: Attempt ${attempt}/2 FAILED with error: ${errorMessage}`);
        
        if (debugBing) {
          console.error(`[SearchEngine] BING: Full error details:`, error);
        }
        
        if (attempt === 2) {
          console.error(`[SearchEngine] BING: All attempts exhausted, giving up`);
          throw error; // Re-throw on final attempt
        }
        // Small delay before retry
        console.error(`[SearchEngine] BING: Waiting 500ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, 500));
      } finally {
        // Always close the dedicated browser
        if (browser) {
          try {
            await browser.close();
            if (debugBing) {
              console.error(`[SearchEngine] BING: Browser closed successfully`);
            }
          } catch (closeError) {
            console.error(`[SearchEngine] BING: Error closing browser:`, closeError);
          }
        }
      }
    }
    
    throw new Error('All Bing search attempts failed');
  }

  private async tryBrowserBingSearchInternal(browser: any, query: string, numResults: number, timeout: number): Promise<SearchResult[]> {
    const debugBing = process.env.DEBUG_BING_SEARCH === 'true';
    
    // Validate browser is still functional before proceeding
    if (!browser.isConnected()) {
      console.error(`[SearchEngine] BING: Browser is not connected`);
      throw new Error('Browser is not connected');
    }
    
    console.error(`[SearchEngine] BING: Creating browser context with enhanced fingerprinting...`);
    
    try {
      // Enhanced browser context with more realistic fingerprinting
      const context = await browser.newContext({
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
          'Accept-Encoding': 'gzip, deflate, br',
          'DNT': '1',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none'
        }
      });

      console.error(`[SearchEngine] BING: Context created, opening new page...`);
      const page = await context.newPage();
      console.error(`[SearchEngine] BING: Page opened successfully`);
      
      try {
        // Try enhanced Bing search with proper web interface flow
        try {
          console.error(`[SearchEngine] BING: Attempting enhanced search (homepage → form submission)...`);
          const results = await this.tryEnhancedBingSearch(page, query, numResults, timeout);
          console.error(`[SearchEngine] BING: Enhanced search succeeded with ${results.length} results`);
          await context.close();
          return results;
        } catch (enhancedError) {
          const errorMessage = enhancedError instanceof Error ? enhancedError.message : 'Unknown error';
          console.error(`[SearchEngine] BING: Enhanced search failed: ${errorMessage}`);
          
          if (debugBing) {
            console.error(`[SearchEngine] BING: Enhanced search error details:`, enhancedError);
          }
          
          console.error(`[SearchEngine] BING: Falling back to direct URL search...`);
          
          // Fallback to direct URL approach with enhanced parameters
          const results = await this.tryDirectBingSearch(page, query, numResults, timeout);
          console.error(`[SearchEngine] BING: Direct search succeeded with ${results.length} results`);
          await context.close();
          return results;
        }
      } catch (error) {
        // Ensure context is closed even on error
        console.error(`[SearchEngine] BING: All search methods failed, closing context...`);
        await context.close();
        throw error;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[SearchEngine] BING: Internal search failed: ${errorMessage}`);
      
      if (debugBing) {
        console.error(`[SearchEngine] BING: Internal search error details:`, error);
      }
      
      throw error;
    }
  }

  private async tryEnhancedBingSearch(page: any, query: string, numResults: number, timeout: number): Promise<SearchResult[]> {
    const debugBing = process.env.DEBUG_BING_SEARCH === 'true';
    console.error(`[SearchEngine] BING: Enhanced search - navigating to Bing homepage...`);
    
    // Navigate to Bing homepage first to establish proper session
    const startTime = Date.now();
    await page.goto('https://www.bing.com', { 
      waitUntil: 'domcontentloaded',
      timeout: timeout / 2
    });
    
    const loadTime = Date.now() - startTime;
    const pageTitle = await page.title();
    const currentUrl = page.url();
    console.error(`[SearchEngine] BING: Homepage loaded in ${loadTime}ms, title: "${pageTitle}", URL: ${currentUrl}`);
    
    // Wait a moment for page to fully load
    await page.waitForTimeout(500);
    
    // Find and use the search box (more realistic than direct URL)
    try {
      console.error(`[SearchEngine] BING: Looking for search form elements...`);
      await page.waitForSelector('#sb_form_q', { timeout: 2000 });
      console.error(`[SearchEngine] BING: Search box found, filling with query: "${query}"`);
      await page.fill('#sb_form_q', query);
      
      console.error(`[SearchEngine] BING: Clicking search button and waiting for navigation...`);
      // Submit the search form
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: timeout }),
        page.click('#search_icon')
      ]);
      
      const searchLoadTime = Date.now() - startTime;
      const searchPageTitle = await page.title();
      const searchPageUrl = page.url();
      console.error(`[SearchEngine] BING: Search completed in ${searchLoadTime}ms total, title: "${searchPageTitle}", URL: ${searchPageUrl}`);
      
    } catch (formError) {
      const errorMessage = formError instanceof Error ? formError.message : 'Unknown error';
      console.error(`[SearchEngine] BING: Search form submission failed: ${errorMessage}`);
      
      if (debugBing) {
        console.error(`[SearchEngine] BING: Form error details:`, formError);
      }
      
      throw formError;
    }
    
    // Wait for search results to load
    try {
      console.error(`[SearchEngine] BING: Waiting for search results to appear...`);
      await page.waitForSelector('.b_algo, .b_result', { timeout: 3000 });
      console.error(`[SearchEngine] BING: Search results selector found`);
    } catch {
      console.error(`[SearchEngine] BING: Search results selector not found, proceeding with page content anyway`);
    }

    const html = await page.content();
    console.error(`[SearchEngine] BING: Got page HTML with length: ${html.length} characters`);
    
    if (debugBing && html.length < 10000) {
      console.error(`[SearchEngine] BING: WARNING - HTML seems short, possible bot detection or error page`);
    }
    
    const results = this.parseBingResults(html, numResults);
    console.error(`[SearchEngine] BING: Enhanced search parsed ${results.length} results`);
    
    if (results.length === 0) {
      console.error(`[SearchEngine] BING: WARNING - No results found, possible parsing failure or empty search`);
      
      if (debugBing) {
        const sampleHtml = html.substring(0, 1000);
        console.error(`[SearchEngine] BING: Sample HTML for debugging:`, sampleHtml);
      }
    }
    
    return results;
  }

  /**
   * Safely retrieves page properties that might fail due to navigation/context destruction
   */
  private async getSafePageMetadata(page: any): Promise<{ title: string; url: string }> {
    try {
      return {
        title: await page.title(),
        url: page.url(),
      };
    } catch (e) {
      return { title: '', url: '' };
    }
  }

  private async tryDirectBingSearch(page: any, query: string, numResults: number, timeout: number): Promise<SearchResult[]> {
    const debugBing = process.env.DEBUG_BING_SEARCH === 'true';
    console.error(`[SearchEngine] BING: Direct search with enhanced parameters...`);
    
    // Generate a conversation ID (cvid) similar to what Bing uses
    const cvid = this.generateConversationId();
    
    // Construct URL with enhanced parameters based on successful manual searches
    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(numResults, 10)}&form=QBLH&sp=-1&qs=n&cvid=${cvid}`;
    console.error(`[SearchEngine] BING: Navigating to direct URL: ${searchUrl}`);
    
    const startTime = Date.now();
    
    // Try navigation with retries to handle potential redirection/context destruction
    let success = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // Use 'domcontentloaded' initially to be faster and less prone to 'networkidle' timeouts/race conditions
        await page.goto(searchUrl, { 
          waitUntil: 'domcontentloaded',
          timeout: timeout
        });
        
        // Wait for network to settle slightly after domcontentloaded
        await new Promise(resolve => setTimeout(resolve, 500));

        // Then try to wait for networkidle if it's not already stable
        try {
          await page.waitForLoadState('networkidle', { timeout: 2000 });
        } catch {
          // If networkidle times out, it's fine, we already have domcontentloaded and a buffer
        }
 
        success = true;
        break;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'Unknown error';
        console.warn(`[SearchEngine] BING: Direct navigation attempt ${attempt} failed: ${errMsg}`);
        if (attempt === 2) {
          // Final attempt fallback to a faster waitUntil if networkidle fails
          try {
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: timeout / 2 });
            success = true;
            break;
          } catch (finalE) {
            console.error(`[SearchEngine] BING: All navigation attempts failed.`);
          }
        }
        // Small delay before retry
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    if (!success) {
       console.error(`[SearchEngine] BING: Failed to navigate to search results.`);
       // We still attempt to parse whatever state the page is in
    }

    const loadTime = Date.now() - startTime;
    // Use the safe metadata getter which handles context destruction
    const { title: pageTitle, url: currentUrl } = await this.getSafePageMetadata(page);
    console.error(`[SearchEngine] BING: Page state check in ${loadTime}ms, title: "${pageTitle}", URL: ${currentUrl}`);
    
    // Wait for search results to load with a retry mechanism for the selector
    try {
      console.error(`[SearchEngine] BING: Waiting for search results to appear...`);
      // Use dynamic timeout based on remaining budget, capped at 8s
      const dynamicTimeout = Math.min(timeout * 0.7, 8000);
      await page.waitForSelector('.b_algo, .b_result, [class*="b_algo"], [class*="b_result"], .b_card, [role="main"], .b_search_result', {
        timeout: dynamicTimeout,
        state: 'visible'
      });
      // Small buffer to allow potential subsequent redirections or hydration to settle
      await new Promise(resolve => setTimeout(resolve, 1000));
      console.error(`[SearchEngine] BING: Search results selector found`);
    } catch (e) {
      console.error(`[SearchEngine] BING: Search results selector not found or timed out, proceeding with page content anyway`);
    }

    // Additional check: if we have the page but no results are visible, wait a bit more for hydration
    const isResultsPresent = await page.$('.b_algo, .b_result, [class*="b_algo"], [class*="b_result"], .b_search_result');
    if (!isResultsPresent) {
      console.log(`[SearchEngine] BING: Results not immediately visible, waiting for hydration...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    // Retry retrieving content if it fails due to context destruction
    let html = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        html = await page.content();
        break;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : 'Unknown error';
        console.warn(`[SearchEngine] BING: Attempt ${attempt} to get page content failed: ${errMsg}`);
        if (errMsg.includes('context was destroyed')) {
          if (attempt === 3) {
            console.error(`[SearchEngine] BING: Context was destroyed during content retrieval on final attempt. Returning empty results.`);
            return [];
          }
          // If it's not the last attempt, wait a bit and try again
          await new Promise(resolve => setTimeout(resolve, 1500));
        } else {
          // For other errors, break and use whatever we have (or empty)
          break;
        }
      }
    }
    
    console.error(`[SearchEngine] BING: Got page HTML with length: ${html.length} characters`);
    
    if (debugBing && html.length < 10000) {
      console.error(`[SearchEngine] BING: WARNING - HTML seems short, possible bot detection or error page`);
    }
    
    const results = this.parseBingResults(html, numResults);
    console.error(`[SearchEngine] BING: Direct search parsed ${results.length} results`);
    
    if (results.length === 0) {
      console.error(`[SearchEngine] BING: WARNING - No results found, possible parsing failure or empty search`);
      
      if (debugBing) {
        const sampleHtml = html.substring(0, 1000);
        console.error(`[SearchEngine] BING: Sample HTML for debugging:`, sampleHtml);
      }
    }
    
    return results;
  }

  private generateConversationId(): string {
    // Generate a conversation ID similar to Bing's format (32 hex characters)
    const chars = '0123456789ABCDEF';
    let cvid = '';
    for (let i = 0; i < 32; i++) {
      cvid += chars[Math.floor(Math.random() * chars.length)];
    }
    return cvid;
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
    let browser;
    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({
        headless: process.env.BROWSER_HEADLESS !== 'false',
        args: ['--no-sandbox', '--disable-dev-shm-usage']
      });
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
      });
      const page = await context.newPage();
      
      const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web`;
      // Use a reasonable timeout based on the passed parameter, capped at 20s
      await page.goto(searchUrl, {
        waitUntil: 'load',
        timeout: Math.min(timeout, 20000)
      });

      // Wait for results to appear with a timeout that respects the budget
      try {
        await page.waitForSelector('.result__a, .result, [class*="result"]', { 
          timeout: Math.min(timeout * 0.8, 10000) 
        });
      } catch (e) {
        console.warn(`[SearchEngine] DuckDuckGo browser results selector not found or timed out, proceeding anyway`);
      }

      const html = await page.content();
      const results = this.parseDuckDuckGoResults(html, numResults);
      console.log(`[SearchEngine] DuckDuckGo Browser parsed ${results.length} results`);
      
      await context.close();
      return results;
    } catch (error) {
      console.error(`[SearchEngine] DuckDuckGo browser search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw new Error('DuckDuckGo search failed');
    } finally {
      if (browser) await browser.close();
    }
  }

  private parseSearchResults(html: string, maxResults: number): SearchResult[] {
    console.log(`[SearchEngine] Parsing HTML with length: ${html.length}`);
    
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    const timestamp = generateTimestamp();

    // Log what selectors we find - more comprehensive debugging
    const gElements = $('div.g');
    const sokobanElements = $('div[data-sokoban-container]');
    const tF2CxcElements = $('.tF2Cxc');
    const rcElements = $('.rc');
    const vedElements = $('[data-ved]');
    const h3Elements = $('h3');
    const linkElements = $('a[href]');
    
    console.log(`[SearchEngine] Found elements:`);
    console.log(`  - div.g: ${gElements.length}`);
    console.log(`  - div[data-sokoban-container]: ${sokobanElements.length}`);
    console.log(`  - .tF2Cxc: ${tF2CxcElements.length}`);
    console.log(`  - .rc: ${rcElements.length}`);
    console.log(`  - [data-ved]: ${vedElements.length}`);
    console.log(`  - h3: ${h3Elements.length}`);
    console.log(`  - a[href]: ${linkElements.length}`);
    
    // Try multiple approaches to find search results
    const searchResultSelectors = [
      'div.g',
      'div[data-sokoban-container]',
      '.tF2Cxc',
      '.rc',
      '[data-ved]',
      'div[jscontroller]'
    ];
    
    let foundResults = false;
    
    for (const selector of searchResultSelectors) {
      if (foundResults) break;
      
      console.log(`[SearchEngine] Trying selector: ${selector}`);
      const elements = $(selector);
      console.log(`[SearchEngine] Found ${elements.length} elements with selector ${selector}`);
      
      elements.each((_index, element) => {
        if (results.length >= maxResults) return false;
        
        const $element = $(element);
        
        // Try multiple title selectors
        const titleSelectors = ['h3', '.LC20lb', '.DKV0Md', 'a[data-ved]', '.r', '.s'];
        let title = '';
        let url = '';
        
        for (const titleSelector of titleSelectors) {
          const $title = $element.find(titleSelector).first();
          if ($title.length) {
            title = $title.text().trim();
            console.log(`[SearchEngine] Found title with ${titleSelector}: "${title}"`);
            
            // Try to find the link
            const $link = $title.closest('a');
            if ($link.length) {
              url = $link.attr('href') || '';
              console.log(`[SearchEngine] Found URL: "${url}"`);
            } else {
              // Try to find any link in the element
              const $anyLink = $element.find('a[href]').first();
              if ($anyLink.length) {
                url = $anyLink.attr('href') || '';
                console.log(`[SearchEngine] Found URL from any link: "${url}"`);
              }
            }
            break;
          }
        }
        
        // Try multiple snippet selectors
        const snippetSelectors = ['.VwiC3b', '.st', '.aCOpRe', '.IsZvec', '.s3v9rd', '.MUxGbd', '.aCOpRe', '.snippet-content'];
        let snippet = '';
        
        for (const snippetSelector of snippetSelectors) {
          const $snippet = $element.find(snippetSelector).first();
          if ($snippet.length) {
            snippet = $snippet.text().trim();
            console.log(`[SearchEngine] Found snippet with ${snippetSelector}: "${snippet.substring(0, 100)}..."`);
            break;
          }
        }
        
        if (title && url && this.isValidSearchUrl(url)) {
          console.log(`[SearchEngine] Adding result: ${title}`);
          results.push({
            title,
            url: this.cleanGoogleUrl(url),
            description: snippet || 'No description available',
            fullContent: '',
            contentPreview: '',
            wordCount: 0,
            timestamp,
            fetchStatus: 'success',
          });
          foundResults = true;
        } else {
          console.log(`[SearchEngine] Skipping result: title="${title}", url="${url}", isValid=${this.isValidSearchUrl(url)}`);
        }
      });
    }

    console.log(`[SearchEngine] Found ${results.length} results with all selectors`);

    // If still no results, try a more aggressive approach - look for any h3 with links
    if (results.length === 0) {
      console.log(`[SearchEngine] No results found, trying aggressive h3 search...`);
      $('h3').each((_index, element) => {
        if (results.length >= maxResults) return false;
        
        const $h3 = $(element);
        const title = $h3.text().trim();
        const $link = $h3.closest('a');
        
        if ($link.length && title) {
          const url = $link.attr('href') || '';
          console.log(`[SearchEngine] Aggressive search found: "${title}" -> "${url}"`);
          
          if (this.isValidSearchUrl(url)) {
            results.push({
              title,
              url: this.cleanGoogleUrl(url),
              description: 'No description available',
              fullContent: '',
              contentPreview: '',
              wordCount: 0,
              timestamp,
              fetchStatus: 'success',
            });
          }
        }
      });
      
      console.log(`[SearchEngine] Aggressive search found ${results.length} results`);
    }

    return results;
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
    const debugBing = process.env.DEBUG_BING_SEARCH === 'true';
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

  private cleanGoogleUrl(url: string): string {
    // Handle Google's redirect URLs
    if (url.startsWith('/url?')) {
      try {
        const urlParams = new URLSearchParams(url.substring(5));
        const actualUrl = urlParams.get('q') || urlParams.get('url');
        if (actualUrl) {
          return actualUrl;
        }
      } catch {
        console.warn('Failed to parse Google redirect URL:', url);
      }
    }

    // Handle protocol-relative URLs
    if (url.startsWith('//')) {
      return 'https:' + url;
    }

    return url;
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
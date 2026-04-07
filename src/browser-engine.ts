import { chromium, firefox, webkit, Browser, LaunchOptions } from 'playwright';

// Export types for browser engine configuration
export type BrowserEngineType = 'webkit' | 'chromium' | 'firefox' | 'api';
export type HeadlessMode = 'new' | 'legacy' | 'shell';

export interface BrowserEngineOptions {
  engineType?: BrowserEngineType;
  headlessMode?: HeadlessMode;
  args?: string[];
  contextPoolConfig?: {
    maxSize: number;
    reuseTimeoutMs: number;
    maxAgeMs: number;
  };
}

// Default browser engine options
const DEFAULT_ENGINE_OPTIONS: BrowserEngineOptions = {
  engineType: 'webkit', // WebKit is fastest for search tasks
  headlessMode: 'new' as const,  // New headless mode provides better performance
  args: [],
};

/**
 * Returns engine-specific arguments to avoid passing Chromium flags to WebKit/Firefox
 */
function getEngineSpecificArgs(engineType: BrowserEngineType): string[] {
  const baseArgs = [
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];

  if (engineType === 'chromium') {
    return [
      ...baseArgs,
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ];
  }

  return baseArgs;
}

/**
 * Creates an optimized browser instance with the specified engine type
 * Priority: WebKit (fastest) -> Chromium -> Firefox
 */
export async function createOptimizedBrowser(
  options?: BrowserEngineOptions
): Promise<Browser> {
  const effectiveOptions = { ...DEFAULT_ENGINE_OPTIONS, ...options };
  const engineType = effectiveOptions.engineType || 'webkit';
  
  console.log(`[BrowserEngine] Launching browser with engine: ${engineType}, headless mode: ${effectiveOptions.headlessMode}`);
  
  // Build launch options based on browser type and headless mode
  // Use default 'new' if undefined to avoid TS error
  const effectiveHeadlessMode = effectiveOptions.headlessMode || 'new';
  
  // Merge default engine-specific args with provided args
  const engineArgs = getEngineSpecificArgs(engineType);
  const finalArgs = [...new Set([...engineArgs, ...(effectiveOptions.args || [])])];

  const launchOptions: LaunchOptions = {
    headless: getHeadlessOption(effectiveHeadlessMode),
    args: finalArgs,
  };
  
  // Add channel option for Chromium new headless mode
  if (effectiveOptions.engineType === 'chromium' && effectiveOptions.headlessMode !== 'legacy') {
    launchOptions.channel = 'chromium';
  }
  
  let browser: Browser;
  
  try {
    switch (effectiveOptions.engineType) {
      case 'webkit':
        console.log('[BrowserEngine] Using WebKit engine for optimal speed');
        browser = await webkit.launch(launchOptions);
        break;
        
      case 'chromium':
        console.log('[BrowserEngine] Using Chromium engine with new headless mode');
        browser = await chromium.launch(launchOptions);
        break;
        
      case 'firefox':
        console.log('[BrowserEngine] Using Firefox engine as fallback');
        browser = await firefox.launch(launchOptions);
        break;
        
      default:
        console.warn(`[BrowserEngine] Unknown engine type "${effectiveOptions.engineType}", falling back to WebKit`);
        browser = await webkit.launch(launchOptions);
    }
    
    console.log(`[BrowserEngine] Browser launched successfully, connected: ${browser.isConnected()}`); // Intentionally using log for success to stderr via redirect
  return browser;
} catch (error) {
  console.error(`[BrowserEngine] Failed to launch ${effectiveOptions.engineType} browser:`, error); // Intentionally using log for errors to stderr via redirect
  
  // Try fallback engines if primary fails
    if (effectiveOptions.engineType === 'webkit') {
      console.log('[BrowserEngine] Fallback: Trying Chromium...'); // Intentionally using log for debug
      try {
        return await chromium.launch(launchOptions);
      } catch {
        console.log('[BrowserEngine] Chromium also failed, trying Firefox...'); // Intentionally using log for debug
        return await firefox.launch(launchOptions);
      }
    }
    
    throw error;
  }
}

/**
 * Gets the appropriate headless option based on mode and browser type
 */
export function getHeadlessOption(mode: HeadlessMode): boolean {
  // Playwright's launch options only accept boolean for headless
  // 'shell' mode is not available through launch options - use in createOptimizedBrowser instead
  switch (mode) {
    case 'new':
      return true; // New headless mode (true = new headless)
      
    case 'legacy':
      return false; // Legacy headless (visible window, not recommended for production)
      
    default:
      console.warn(`[BrowserEngine] Unknown headless mode "${mode}", using new headless`);
      return true;
  }
}

/**
 * Creates a browser context with optimized settings for web search
 */
export function createOptimizedContextOptions(engineType: BrowserEngineType = 'webkit'): object {
  const userAgents: Record<BrowserEngineType, string> = {
    chromium: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    webkit: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    api: 'SerperAPI/1.0'
  };

  return {
    userAgent: userAgents[engineType] || userAgents.webkit,
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    colorScheme: 'light',
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
    extraHTTPHeaders: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Sec-Ch-Ua': '"Not A(Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
    },
  };
}

/**
 * Gets the recommended browser engine order for performance
 */
export function getEnginePriorityOrder(): BrowserEngineType[] {
  // API is fastest and most reliable, then WebKit, then Chromium, then Firefox
  return ['api', 'webkit', 'chromium', 'firefox'];
}

/**
 * Estimates browser launch time in milliseconds based on engine type
 */
export function estimateLaunchTime(engineType: BrowserEngineType): number {
  switch (engineType) {
    case 'webkit':
      return 1000; // Increased to be more realistic and avoid premature timeouts
    case 'chromium':
      return 1200;
    case 'firefox':
      return 1500;
    default:
      return 1200;
  }
}

/**
 * Validates browser engine type
 */
export function isValidEngineType(type: string): type is BrowserEngineType {
  return ['webkit', 'chromium', 'firefox', 'api'].includes(type);
}

/**
 * Gets environment variable configuration for browser engine
 */
export function getEnvironmentConfig(): BrowserEngineOptions {
  const engineType = process.env.BROWSER_ENGINE as BrowserEngineType;
  const headlessMode = process.env.HEADLESS_MODE as HeadlessMode;
  
  return {
    engineType: isValidEngineType(engineType) ? engineType : 'webkit',
    headlessMode: ['new', 'legacy', 'shell'].includes(headlessMode || '') ? headlessMode! : 'new',
    args: [],
    contextPoolConfig: {
      maxSize: parseInt(process.env.CONTEXT_POOL_SIZE || '10', 10),
      reuseTimeoutMs: parseInt(process.env.CONTEXT_REUSE_TIMEOUT || '30000', 10),
      maxAgeMs: parseInt(process.env.CONTEXT_MAX_AGE || '60000', 10),
    },
  };
}

/**
 * Creates a cleanup function for browser resources
 */
export function createBrowserCleanup(browser: Browser): () => Promise<void> {
  return async () => {
    try {
      if (browser.isConnected()) {
        await browser.close();
        console.log('[BrowserEngine] Browser closed successfully');
      }
    } catch (error) {
      console.error('[BrowserEngine] Error closing browser:', error);
    }
  };
}
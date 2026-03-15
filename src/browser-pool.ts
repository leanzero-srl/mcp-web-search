import { chromium, firefox, webkit, Browser, BrowserContext } from 'playwright';
import { ContextPool, ContextPoolConfig, ContextPoolOptions, getEnvironmentConfig } from './context-pool.js';

export class BrowserPool {
  private contextPool: ContextPool | null = null;
  private maxBrowsers: number;
  private browserTypes: string[];
  private currentBrowserIndex = 0;
  private headless: boolean;
  private lastUsedBrowserType: string = '';
  private legacyMode: boolean; // If true, use old browser-based pooling

  constructor() {
    // Read configuration from environment variables
    this.maxBrowsers = parseInt(process.env.MAX_BROWSERS || '3', 10);
    this.headless = process.env.BROWSER_HEADLESS !== 'false'; // Default to true
    
    // Configure browser types based on environment
    const browserTypesEnv = process.env.BROWSER_TYPES || 'chromium,firefox';
    this.browserTypes = browserTypesEnv.split(',').map(type => type.trim());
    
    // Check if legacy mode is enabled (for backward compatibility)
    this.legacyMode = process.env.USE_LEGACY_POOL === 'true';
    
    console.log(`[BrowserPool] Configuration: maxBrowsers=${this.maxBrowsers}, headless=${this.headless}, types=${this.browserTypes.join(',')}, legacyMode=${this.legacyMode}`);
  }

  async getBrowser(): Promise<Browser> {
    // Use new context pool if not in legacy mode
    if (!this.legacyMode) {
      return this.getBrowserWithContextPool();
    }
    
    // Fallback to legacy browser pooling
    return this.getBrowserLegacy();
  }

  /**
   * Gets a browser using the new context pool approach (recommended)
   */
  private async getBrowserWithContextPool(): Promise<Browser> {
    if (!this.contextPool) {
      const envConfig = getEnvironmentConfig();
      
      const config: ContextPoolConfig = {
        maxSize: parseInt(process.env.CONTEXT_POOL_SIZE || '10', 10),
        reuseTimeoutMs: parseInt(process.env.CONTEXT_REUSE_TIMEOUT || '30000', 10),
        maxAgeMs: parseInt(process.env.CONTEXT_MAX_AGE || '60000', 10),
      };
      
      this.contextPool = new ContextPool({
        engineType: envConfig.engineType,
        headlessMode: envConfig.headlessMode,
        config,
      });
    }
    
    // Note: This method returns a browser for compatibility
    // The actual context pooling is handled in getContext() method
    return await this.contextPool['getBrowser']();
  }

  /**
   * Legacy browser-based pooling (for backward compatibility)
   */
  private async getBrowserLegacy(): Promise<Browser> {
    // Rotate between browser types for variety
    const browserType = this.browserTypes[this.currentBrowserIndex % this.browserTypes.length];
    this.currentBrowserIndex++;
    this.lastUsedBrowserType = browserType;

    if (this.browsers.has(browserType)) {
      const browser = this.browsers.get(browserType)!;
      
      // Check if browser is still connected and healthy
      try {
        if (browser.isConnected()) {
          // Quick health check by trying to create and close a context
          // Use minimal options to avoid Firefox isMobile issues
          const testContext = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
          });
          await testContext.close();
          return browser;
        }
      } catch (error) {
        console.log(`[BrowserPool] Browser ${browserType} health check failed:`, error);
        // Browser is unhealthy, remove it and close if possible
        this.browsers.delete(browserType);
        try {
          await browser.close();
        } catch (closeError) {
          console.log(`[BrowserPool] Error closing unhealthy browser:`, closeError);
        }
      }
    }

    // Launch new browser
    console.log(`[BrowserPool] Launching new ${browserType} browser`);
    
    const launchOptions = {
      headless: this.headless,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
      ],
    };

    let browser: Browser;
    try {
      switch (browserType) {
        case 'chromium':
          browser = await chromium.launch(launchOptions);
          break;
        case 'firefox':
          browser = await firefox.launch(launchOptions);
          break;
        case 'webkit':
          browser = await webkit.launch(launchOptions);
          break;
        default:
          browser = await chromium.launch(launchOptions);
      }

      this.browsers.set(browserType, browser);
      
      // Clean up old browsers if we have too many
      if (this.browsers.size > this.maxBrowsers) {
        const oldestBrowser = this.browsers.entries().next().value;
        if (oldestBrowser) {
          try {
            await oldestBrowser[1].close();
          } catch (error) {
            console.error(`[BrowserPool] Error closing old browser:`, error);
          }
          this.browsers.delete(oldestBrowser[0]);
        }
      }

      return browser;
    } catch (error) {
      console.error(`[BrowserPool] Failed to launch ${browserType} browser:`, error);
      throw error;
    }
  }

  private browsers: Map<string, Browser> = new Map();

  /**
   * Gets a browser context from the pool
   */
  async getContext(): Promise<BrowserContext> {
    if (!this.contextPool) {
      const envConfig = getEnvironmentConfig();
      
      const config: ContextPoolConfig = {
        maxSize: parseInt(process.env.CONTEXT_POOL_SIZE || '10', 10),
        reuseTimeoutMs: parseInt(process.env.CONTEXT_REUSE_TIMEOUT || '30000', 10),
        maxAgeMs: parseInt(process.env.CONTEXT_MAX_AGE || '60000', 10),
      };
      
      this.contextPool = new ContextPool({
        engineType: envConfig.engineType,
        headlessMode: envConfig.headlessMode,
        config,
      });
    }
    
    return await this.contextPool.getContext();
  }

  /**
   * Releases a context back to the pool for reuse
   */
  async releaseContext(context: BrowserContext): Promise<void> {
    if (this.contextPool) {
      await this.contextPool.releaseContext(context);
    }
  }

  async closeAll(): Promise<void> {
    console.log(`[BrowserPool] Closing all browsers/contexts`);
    
    // Close the context pool
    if (this.contextPool) {
      try {
        await this.contextPool.closeAll();
      } catch (error) {
        console.error('[BrowserPool] Error closing context pool:', error);
      }
    }
    
    // Close legacy browsers if any exist
    const closePromises = Array.from(this.browsers.values()).map(browser => 
      browser.close().catch(error => 
        console.error('Error closing browser:', error)
      )
    );
    
    await Promise.all(closePromises);
    this.browsers.clear();
  }

  getLastUsedBrowserType(): string {
    return this.lastUsedBrowserType;
  }
}
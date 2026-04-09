import { Browser, BrowserContext } from 'playwright';
import { createOptimizedBrowser, getEnvironmentConfig, type BrowserEngineType, type HeadlessMode, type BrowserEngineOptions, createOptimizedContextOptions } from './browser-engine.js';
import crypto from 'crypto';

// Re-export for convenience

// Re-export for convenience
export { getEnvironmentConfig };

// Context pool configuration
export interface ContextPoolConfig {
  maxSize: number;
  reuseTimeoutMs: number;
  maxAgeMs: number;
}

// Individual context record in the pool
interface ContextRecord {
  context: BrowserContext;
  lastUsed: number;
  ageStart: number;
  isHealthy: boolean;
}

// Export types for compatibility
export type { BrowserEngineType, HeadlessMode };
export interface ContextPoolOptions extends BrowserEngineOptions {
  config?: ContextPoolConfig;
}

// Default configuration
const DEFAULT_CONFIG: ContextPoolConfig = {
  maxSize: 10,
  reuseTimeoutMs: 30000,
  maxAgeMs: 60000,
};

/**
 * Manages a pool of reusable browser contexts for improved performance
 * Instead of launching new browsers (~500ms), we reuse existing contexts (~10-50ms)
 */
export class ContextPool {
  private contexts: Map<string, ContextRecord> = new Map();
  private maxSize: number;
  private reuseTimeoutMs: number;
  private maxAgeMs: number;
  private engineType: BrowserEngineType;
  private headlessMode: HeadlessMode;
  
  constructor(options?: ContextPoolOptions) {
    const config = options?.config || DEFAULT_CONFIG;
    
    this.maxSize = config.maxSize;
    this.reuseTimeoutMs = config.reuseTimeoutMs;
    this.maxAgeMs = config.maxAgeMs;
    this.engineType = options?.engineType || 'webkit';
    this.headlessMode = options?.headlessMode || 'new';
    
    console.log(`[ContextPool] Configuration: maxSize=${this.maxSize}, reuseTimeout=${this.reuseTimeoutMs}ms, maxAge=${this.maxAgeMs}ms, engine=${this.engineType}`);
  }

  /**
   * Gets a browser context from the pool or creates a new one
   */
  async getContext(): Promise<BrowserContext> {
    // First, try to get an existing healthy context that hasn't timed out
    const availableContext = this.findAvailableContext();
    
    if (availableContext) {
      console.log(`[ContextPool] Reusing existing context (${this.contexts.size} total in pool)`);
      return availableContext;
    }
    
    // If no available context, check if we can create a new one
    if (this.contexts.size < this.maxSize) {
      console.log(`[ContextPool] Creating new context (pool size: ${this.contexts.size}/${this.maxSize})`);
      const browser = await this.getBrowser();
      return await this.createAndStoreContext(browser);
    }
    
    // Pool is full, wait for a timeout and retry
    console.log(`[ContextPool] Pool full (${this.contexts.size}/${this.maxSize}), waiting for available context...`);
    
    // Wait for any context to become available
    await new Promise(resolve => setTimeout(resolve, this.reuseTimeoutMs));
    
    // Try again after waiting
    const fallbackContext = this.findAvailableContext();
    if (fallbackContext) {
      return fallbackContext;
    }
    
    // Force reuse the oldest context if pool is still full
    console.log(`[ContextPool] Forcing reuse of oldest context`);
    const oldestRecord = this.getOldestContextRecord();
    if (oldestRecord) {
      await this.invalidateContext(oldestRecord);
      const browser = await this.getBrowser();
      return await this.createAndStoreContext(browser);
    }
    
    // Last resort: create a new browser and context
    console.log(`[ContextPool] Creating new browser instance due to pool exhaustion`);
    const browser = await this.getBrowser();
    return await this.createAndStoreContext(browser);
  }

  /**
   * Gets or creates the underlying browser instance
   */
  private async getBrowser(): Promise<Browser> {
    // We use a single shared browser for all contexts in the pool
    if (!this.sharedBrowser) {
      console.log('[ContextPool] Launching new browser');
      this.sharedBrowser = await createOptimizedBrowser({
        engineType: this.engineType,
        headlessMode: this.headlessMode,
      });
      
      // Set up cleanup on process exit
      process.on('exit', async () => {
        await this.closeAll();
      });
    }
    
    return this.sharedBrowser;
  }

  private sharedBrowser: Browser | null = null;

  /**
   * Creates a new context and stores it in the pool
   */
  private async createAndStoreContext(browser: Browser): Promise<BrowserContext> {
    const options = createOptimizedContextOptions(this.engineType as any);
    
    const context = await browser.newContext(options as any);
    
    // Store the context with metadata
    const now = Date.now();
    // Use a more reliable unique ID for the context record
    const contextId = crypto.randomUUID();
    
    // Attach the internal ID to the context object so we can find it later during release
    (context as any).__pool_id = contextId;

    this.contexts.set(contextId, {
      context,
      lastUsed: now,
      ageStart: now,
      isHealthy: true,
    });
    
    console.log(`[ContextPool] Created new context (${this.contexts.size} total)`);
    
    return context;
  }

  /**
   * Finds an available (healthy and not timed out) context in the pool
   */
  private findAvailableContext(): BrowserContext | null {
    const now = Date.now();
    
    for (const [guid, record] of this.contexts.entries()) {
      if (!record.isHealthy) continue;
      
      // Check if context has exceeded max age
      if (now - record.ageStart > this.maxAgeMs) {
        console.log(`[ContextPool] Context ${guid} expired (age: ${(now - record.ageStart)}ms > ${this.maxAgeMs}ms)`);
        this.invalidateContext(record);
        continue;
      }
      
      // Check if context has timed out
      if (now - record.lastUsed > this.reuseTimeoutMs) {
        console.log(`[ContextPool] Context ${guid} timed out (idle: ${(now - record.lastUsed)}ms > ${this.reuseTimeoutMs}ms)`);
        continue;
      }
      
      // Perform health check by trying to create a quick page
      if (!this.healthCheck(record)) {
        this.invalidateContext(record);
        continue;
      }
      
      // Update last used time
      record.lastUsed = now;
      return record.context;
    }
    
    return null;
  }

  /**
   * Performs a quick health check on a context
   */
  private async healthCheck(record: ContextRecord): Promise<boolean> {
    try {
      // Quick check: verify browser is still connected
      const browser = record.context.browser();
      if (!browser || !browser.isConnected()) {
        console.log('[ContextPool] Browser disconnected during health check');
        return false;
      }
      
      // Create and immediately close a test page to ensure context is responsive
      const page = await record.context.newPage();
      await page.close();
      
      return true;
    } catch (error) {
      console.log(`[ContextPool] Context health check failed:`, error);
      return false;
    }
  }

  /**
   * Invalidates a context (marks as unhealthy and removes from pool)
   */
  private invalidateContext(record: ContextRecord): void {
    record.isHealthy = false;
    
    // Close the actual context
    record.context.close().catch(error => {
      console.log(`[ContextPool] Error closing context:`, error);
    });
    
    // Use the internal ID we assigned
    const contextId = (record.context as any).__pool_id;
    if (contextId) {
      this.contexts.delete(contextId);
    } else {
      // Fallback if for some reason ID is missing
      for (const [guid, r] of this.contexts.entries()) {
        if (r === record) {
          this.contexts.delete(guid);
          break;
        }
      }
    }
  }

  /**
   * Gets the oldest context record in the pool
   */
  private getOldestContextRecord(): ContextRecord | null {
    let oldest: ContextRecord | null = null;
    let oldestTime = Infinity;
    
    for (const record of this.contexts.values()) {
      if (record.ageStart < oldestTime) {
        oldestTime = record.ageStart;
        oldest = record;
      }
    }
    
    return oldest;
  }

  /**
   * Releases a context back to the pool for reuse
   */
  async releaseContext(context: BrowserContext): Promise<void> {
    const contextId = (context as any).__pool_id;
    if (contextId) {
      const record = this.contexts.get(contextId);
      if (record) {
        record.lastUsed = Date.now();
        console.log(`[ContextPool] Context released for reuse (${this.contexts.size} total)`);
      }
    } else {
      // If it doesn't have a pool ID, it might not be from the pool
      console.log(`[ContextPool] Attempted to release context without pool ID - likely not from pool`);
    }
  }

  /**
   * Gets the current pool size
   */
  getSize(): number {
    return this.contexts.size;
  }

  /**
   * Gets the maximum pool size
   */
  getMaxSize(): number {
    return this.maxSize;
  }

  /**
   * Closes all contexts in the pool and the shared browser
   */
  async closeAll(): Promise<void> {
    console.log(`[ContextPool] Closing ${this.contexts.size} contexts`);
    
    // Close all contexts
    for (const record of this.contexts.values()) {
      try {
        await record.context.close();
      } catch {
        // Context already closed or error occurred
      }
    }
    
    // Close the shared browser
    // Use null-safe access for sharedBrowser
    const browser = this.sharedBrowser;
    if (browser && browser.isConnected()) {
      try {
        await browser.close();
        console.log('[ContextPool] Shared browser closed');
      } catch (error) {
        console.error('[ContextPool] Error closing shared browser:', error);
      }
    }
    
    this.contexts.clear();
    this.sharedBrowser = null;
  }

  /**
   * Gets environment-based configuration
   */
  static fromEnvironment(): ContextPoolOptions {
    const envConfig = getEnvironmentConfig();
    
    return {
      ...envConfig,
      config: {
        maxSize: parseInt(process.env.CONTEXT_POOL_SIZE || '10', 10),
        reuseTimeoutMs: parseInt(process.env.CONTEXT_REUSE_TIMEOUT || '30000', 10),
        maxAgeMs: parseInt(process.env.CONTEXT_MAX_AGE || '60000', 10),
      },
    };
  }
}

/**
 * Simple context manager for single-request contexts
 */
export class SingleContextManager {
  private context: BrowserContext | null = null;
  private browser: Browser | null = null;

  async createContext(options?: BrowserEngineOptions): Promise<BrowserContext> {
    if (!this.browser) {
      this.browser = await createOptimizedBrowser({
        engineType: options?.engineType || 'webkit',
        headlessMode: options?.headlessMode || 'new',
      });
    }
    
    const context = await this.browser.newContext();
    this.context = context;
    return context;
  }

  async close(): Promise<void> {
    if (this.context) {
      // isClosed() may not exist on all Playwright versions, use try-catch instead
      try {
        await this.context.close();
      } catch {
        // Context already closed or error occurred
      }
      this.context = null;
    }
    
    if (this.browser && this.browser.isConnected()) {
      await this.browser.close();
      this.browser = null;
    }
  }

  getContext(): BrowserContext | null {
    return this.context;
  }
}
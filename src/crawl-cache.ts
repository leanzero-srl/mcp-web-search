/**
 * Crawl Cache System
 * 
 * Stores crawled page content with metadata to avoid re-crawling.
 * Uses a JSON-based storage system for easy management.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Get the directory where this module is located
// In CommonJS: use __dirname directly
// In ES modules: resolve from import.meta.url (not available in CJS bundle)
const getModuleDir = (): string => {
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }
  // Fallback to resolving from the file
  try {
    const url = new URL('file:' + __filename);
    return path.dirname(url.pathname);
  } catch {
    return path.resolve();
  }
};

const moduleDir = getModuleDir();

export interface CrawlCacheEntry {
  url: string;
  timestamp: string;
  expiresAt: string;
  contentHash: string;
  docType?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface CacheIndex {
  entries: CrawlCacheEntry[];
  lastUpdated: string;
  totalEntries: number;
}

// Default cache directory (relative to this module's location)
const DEFAULT_CACHE_DIR = path.join(moduleDir, '../../docs/technical');
const CACHE_FILE = 'crawl-cache.json';
const DEFAULT_TTL_MS = 86400000; // 24 hours

export class CrawlCache {
  private cacheDir: string;
  private cacheFile: string;
  private ttlMs: number;
  private index: CacheIndex;

  constructor(options?: {
    cacheDir?: string;
    ttlMs?: number;
  }) {
    this.cacheDir = options?.cacheDir || DEFAULT_CACHE_DIR;
    this.ttlMs = options?.ttlMs || DEFAULT_TTL_MS;
    this.cacheFile = path.join(this.cacheDir, CACHE_FILE);
    
    // Initialize the index
    this.index = {
      entries: [],
      lastUpdated: new Date().toISOString(),
      totalEntries: 0,
    };
    
    // Ensure cache directory exists
    this.initCacheDirectory();
    
    // Load existing cache
    this.loadCache();
    
    console.log(`[CrawlCache] Initialized with TTL=${this.ttlMs}ms, cache file: ${this.cacheFile}`);
  }

  private initCacheDirectory(): void {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
        console.log(`[CrawlCache] Created cache directory: ${this.cacheDir}`);
      }
      
      // Create subdirectories for OpenAPI downloads
      const openapiDir = path.join(this.cacheDir, 'openapi');
      if (!fs.existsSync(openapiDir)) {
        fs.mkdirSync(openapiDir, { recursive: true });
        console.log(`[CrawlCache] Created OpenAPI directory: ${openapiDir}`);
      }
    } catch (error) {
      console.error(`[CrawlCache] Error creating cache directory:`, error);
    }
  }

  private loadCache(): void {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const data = fs.readFileSync(this.cacheFile, 'utf8');
        this.index = JSON.parse(data);
        console.log(`[CrawlCache] Loaded ${this.index.totalEntries} cached entries`);
      }
    } catch (error) {
      console.warn('[CrawlCache] Failed to load cache, starting fresh:', error);
      this.index = {
        entries: [],
        lastUpdated: new Date().toISOString(),
        totalEntries: 0,
      };
    }
  }

  private saveCache(): void {
    try {
      this.index.lastUpdated = new Date().toISOString();
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.index, null, 2));
    } catch (error) {
      console.error(`[CrawlCache] Error saving cache:`, error);
    }
  }

  private generateHash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
  }

  /**
   * Check if a URL is cached and not expired
   */
  public get(url: string): CrawlCacheEntry | null {
    const now = Date.now();
    
    for (const entry of this.index.entries) {
      if (entry.url === url) {
        // Check if entry has expired
        const expiresAt = new Date(entry.expiresAt).getTime();
        if (now < expiresAt) {
          return entry;
        } else {
          // Entry has expired, remove it
          this.remove(url);
          break;
        }
      }
    }
    
    return null;
  }

  /**
   * Cache a URL with its content and metadata
   */
  public set(
    url: string,
    content: string,
    options?: {
      title?: string;
      docType?: string;
      ttlMs?: number;
      metadata?: Record<string, unknown>;
    }
  ): CrawlCacheEntry {
    const now = Date.now();
    const expiresAt = new Date(now + (options?.ttlMs || this.ttlMs)).toISOString();
    
    const entry: CrawlCacheEntry = {
      url,
      timestamp: new Date().toISOString(),
      expiresAt,
      contentHash: this.generateHash(content),
      docType: options?.docType,
      title: options?.title,
      metadata: options?.metadata,
    };
    
    // Remove existing entry if it exists
    this.remove(url);
    
    // Add new entry
    this.index.entries.push(entry);
    this.index.totalEntries++;
    
    this.saveCache();
    
    console.log(`[CrawlCache] Cached ${url} (${entry.docType || 'unknown'})`);
    
    return entry;
  }

  /**
   * Remove a URL from cache
   */
  public remove(url: string): boolean {
    const initialLength = this.index.entries.length;
    this.index.entries = this.index.entries.filter(entry => entry.url !== url);
    
    if (this.index.entries.length < initialLength) {
      this.index.totalEntries = this.index.entries.length;
      this.saveCache();
      console.log(`[CrawlCache] Removed ${url} from cache`);
      return true;
    }
    
    return false;
  }

  /**
   * Clear all cached entries
   */
  public clear(): void {
    this.index.entries = [];
    this.index.totalEntries = 0;
    this.saveCache();
    console.log('[CrawlCache] Cleared all cache entries');
  }

  /**
   * Get all cached entries
   */
  public getAll(): CrawlCacheEntry[] {
    const now = Date.now();
    
    // Filter out expired entries
    return this.index.entries.filter(entry => {
      const expiresAt = new Date(entry.expiresAt).getTime();
      return now < expiresAt;
    });
  }

  /**
   * Find cached entry by partial URL match
   */
  public findByPartialUrl(partial: string): CrawlCacheEntry[] {
    const now = Date.now();
    
    return this.index.entries.filter(entry => {
      // Check if entry has expired
      const expiresAt = new Date(entry.expiresAt).getTime();
      if (now >= expiresAt) return false;
      
      return entry.url.includes(partial);
    });
  }

  /**
   * Get cache statistics
   */
  public getStats(): { total: number; valid: number; size?: number } {
    const now = Date.now();
    const validEntries = this.index.entries.filter(entry => {
      const expiresAt = new Date(entry.expiresAt).getTime();
      return now < expiresAt;
    });
    
    // Estimate size from file
    let size = 0;
    try {
      size = fs.statSync(this.cacheFile).size;
    } catch {
      // Ignore error
    }
    
    return {
      total: this.index.totalEntries,
      valid: validEntries.length,
      size,
    };
  }

  /**
   * Get the OpenAPI downloads directory
   */
  public getOpenAPIDir(): string {
    const openapiDir = path.join(this.cacheDir, 'openapi');
    if (!fs.existsSync(openapiDir)) {
      fs.mkdirSync(openapiDir, { recursive: true });
    }
    return openapiDir;
  }

  /**
   * Save OpenAPI specification to file
   */
  public saveOpenAPISpec(
    fileName: string,
    content: string | object
  ): { path: string; size: number } {
    const openapiDir = this.getOpenAPIDir();
    const filePath = path.join(openapiDir, fileName);
    
    // Ensure the file has .json extension
    let finalPath = filePath;
    if (!finalPath.endsWith('.json')) {
      finalPath += '.json';
    }
    
    const jsonString = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    fs.writeFileSync(finalPath, jsonString);
    
    const stats = fs.statSync(finalPath);
    
    console.log(`[CrawlCache] Saved OpenAPI spec: ${finalPath} (${stats.size} bytes)`);
    
    return { path: finalPath, size: stats.size };
  }

  /**
   * Load a previously saved OpenAPI spec
   */
  public loadOpenAPISpec(filePath: string): string | null {
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf8');
      }
      
      // Try with .json extension
      const jsonPath = filePath.endsWith('.json') ? filePath : `${filePath}.json`;
      if (fs.existsSync(jsonPath)) {
        return fs.readFileSync(jsonPath, 'utf8');
      }
    } catch (error) {
      console.error(`[CrawlCache] Error loading OpenAPI spec:`, error);
    }
    
    return null;
  }

  /**
   * Check if a file already exists in the OpenAPI directory
   */
  public openAPIFileExists(fileName: string): boolean {
    const openapiDir = this.getOpenAPIDir();
    let filePath = path.join(openapiDir, fileName);
    if (!filePath.endsWith('.json')) {
      filePath += '.json';
    }
    
    return fs.existsSync(filePath);
  }
}

// Create a singleton instance
export const crawlCache = new CrawlCache();
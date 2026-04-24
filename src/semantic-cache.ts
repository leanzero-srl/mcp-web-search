/**
 * MCP Web Search - Semantic Cache Module
 * 
 * Provides intelligent caching with semantic similarity matching:
 * - Cache search results by query semantic meaning, not just exact match
 * - Automatic cache invalidation based on freshness requirements
 * - Memory-efficient storage with configurable limits
 */

import { SemanticCache as UpstashSemanticCache } from "@upstash/semantic-cache";
import { Index } from "@upstash/vector";
import { auditLogger } from './observability.js';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Semantic cache entry structure (maintaining compatibility with existing callers)
 */
export interface SemanticCacheEntry {
  id: string;
  query: string;
  results: any;
  createdAt: number;
  expiresAt?: number;
  semanticHash: string; // Kept for backward compatibility, though Upstash handles similarity internally
}

/**
 * In-flight request cache to prevent duplicate concurrent lookups.
 * OPTIMIZATION: When multiple identical queries arrive simultaneously,
 * only one makes the actual API call and others wait for it.
 * Max size capped to prevent memory leaks under sustained load.
 */
const pendingCache = new Map<string, { promise: Promise<SemanticCacheEntry | null>; expiresAt: number }>();
const PENDING_CACHE_MAX_SIZE = 100;

/**
 * Semantic cache configuration
 */
export interface SemanticCacheConfig {
  maxSize?: number;
  defaultTtl?: number;
  enabled?: boolean;
  minProximity?: number;
}

// ============================================================================
// Semantic Cache Implementation (Powered by Upstash)
// ============================================================================

/**
 * Semantic cache for storing and retrieving search results using vector similarity
 */
export class SemanticCache {
  private upstashCache?: UpstashSemanticCache;
  private readonly config: SemanticCacheConfig;

  constructor(config: Partial<SemanticCacheConfig> = {}) {
    this.config = {
      maxSize: config.maxSize || 1000,
      defaultTtl: config.defaultTtl || 3600000, // 1 hour
      enabled: config.enabled !== undefined ? config.enabled : true,
      minProximity: config.minProximity ?? 0.9,
    };

    const vectorUrl = process.env.UPSTASH_VECTOR_REST_URL;
    const vectorToken = process.env.UPSTASH_VECTOR_REST_TOKEN;

    if (vectorUrl && vectorToken) {
      try {
        const vectorIndex = new Index({
          url: vectorUrl,
          token: vectorToken,
        });

        this.upstashCache = new UpstashSemanticCache({
          index: vectorIndex as any, // Bypass potential type mismatch with protected properties
          minProximity: this.config.minProximity ?? 0.9,
        });
        console.log('[SemanticCache] Initialized successfully');
      } catch (error) {
        console.warn('[SemanticCache] Failed to initialize:', error);
      }
    } else {
      console.log('[SemanticCache] Skipping initialization - UPSTASH_VECTOR_REST_URL or UPSTASH_VECTOR_REST_TOKEN not set');
    }
  }

  private getCache(): UpstashSemanticCache | null {
    return this.upstashCache ?? null;
  }

  /**
   * Get a cached entry if it exists and is valid.
   *
   * OPTIMIZATION: Uses in-flight request cache to prevent duplicate concurrent lookups.
   * When multiple identical queries arrive simultaneously (within ~30s window),
   * they share the same in-flight request instead of each hitting the cache/API.
   */
  public async get(query: string): Promise<SemanticCacheEntry | null> {
    if (!this.config.enabled) return null;

    const cache = this.getCache();
    if (!cache) return null;

    // OPTIMIZATION: Check for in-flight request first
    const normalizedQuery = query.toLowerCase().trim();
    const now = Date.now();

    // Clean up expired entries
    for (const [key, entry] of pendingCache.entries()) {
      if (entry.expiresAt < now) {
        pendingCache.delete(key);
      }
    }

    // Check if there's already an in-flight request for this query
    const pending = pendingCache.get(normalizedQuery);
    if (pending && pending.expiresAt > now) {
      console.log(`[SemanticCache] 🔄 Reusing in-flight request for "${normalizedQuery}"`);
      return pending.promise;
    }

    // Create the cache lookup promise
    const cachePromise = this.performCacheLookup(cache, normalizedQuery);

    // Evict oldest entry if at capacity (LRU eviction)
    if (pendingCache.size >= PENDING_CACHE_MAX_SIZE) {
      const oldestKey = pendingCache.keys().next().value;
      if (oldestKey) pendingCache.delete(oldestKey);
    }

    // Store as in-flight request (30 second window for deduplication)
    pendingCache.set(normalizedQuery, {
      promise: cachePromise,
      expiresAt: now + 30000
    });

    try {
      const result = await cachePromise;
      return result;
    } finally {
      // Clean up after completion (allow a small buffer for late arrivals)
      setTimeout(() => pendingCache.delete(normalizedQuery), 2000);
    }
  }

  /**
   * Internal method to perform the actual cache lookup with timeout
   */
  private async performCacheLookup(cache: UpstashSemanticCache, query: string): Promise<SemanticCacheEntry | null> {
    try {
      // Upstash SemanticCache.get returns the value stored in 'set'
      // Wrap with 2s timeout — if Upstash is slow, fall through to fresh search
      const cached = await Promise.race([
        cache.get(query),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
      ]);

      if (cached) {
        // If we stored as a JSON string, parse it back to an object
        const entry = typeof cached === 'string' ? JSON.parse(cached) : cached;
        auditLogger.logCacheHit(`semantic:${query}`, new Date().toISOString());
        return entry as SemanticCacheEntry;
      }

      auditLogger.logCacheMiss(`query:${query}`);
      return null;
    } catch (error) {
      console.error(`[SemanticCache] Error during get for "${query}":`, error);
      return null;
    }
  }

  /**
   * Store a result in the cache
   */
  public async set(query: string, results: any, ttl?: number): Promise<void> {
    if (!this.config.enabled) return;

    const cache = this.getCache();
    if (!cache) return;

    try {
      const entry: SemanticCacheEntry = {
        id: `${Date.now()}-${Math.random().toString(36).substring(7)}`,
        query,
        results,
        createdAt: Date.now(),
        expiresAt: ttl ? Date.now() + ttl : Date.now() + this.config.defaultTtl!,
        semanticHash: '', // Not used by Upstash implementation
      };

      // Store as JSON string to ensure compatibility with all cache provider versions
      // Wrap with 3s timeout — if Upstash is slow, fail gracefully (data will be re-cached next time)
      await Promise.race([
        cache.set(query, JSON.stringify(entry)),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Cache set timeout')), 3000)),
      ]);
      
      auditLogger.log({
        timestamp: new Date().toISOString(),
        level: 'debug',
        event: 'cache_set',
        query: `stored:${query}`,
        metadata: { provider: 'upstash' },
      });
    } catch (error) {
      console.error(`[SemanticCache] Error during set for "${query}":`, error);
    }
  }

  /**
   * Clear all cache entries
   */
  public async clear(): Promise<void> {
    // Note: Upstash SemanticCache doesn't have a direct 'clear all' in the JS SDK 
    // as it's managed via the vector index. For this implementation, we log the intent.
    console.warn('[SemanticCache] Clear requested - manual cleanup of Upstash index may be required.');
    auditLogger.log({
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'cache_clear_requested',
      query: 'all',
    });
  }

  /**
   * Get cache statistics (Note: Upstash-specific stats are limited in the client)
   */
  public getStats(): {
    size: number;
    maxSize: number;
    enabled: boolean;
  } {
    return {
      size: 0, // Exact size not easily available from client side
      maxSize: this.config.maxSize!,
      enabled: this.config.enabled!,
    };
  }
}

// ============================================================================
// Global Instance
// ============================================================================

/**
 * Default semantic cache instance
 */
export const semanticCache = new SemanticCache({
  maxSize: parseInt(process.env.SEMANTIC_CACHE_MAX_SIZE || '1000', 10),
  defaultTtl: parseInt(process.env.SEMANTIC_CACHE_TTL || '3600000', 10), // 1 hour
});

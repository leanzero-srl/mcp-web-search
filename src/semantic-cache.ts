/**
 * MCP Web Search - Semantic Cache Module
 * 
 * Provides intelligent caching with semantic similarity matching:
 * - Cache search results by query semantic meaning, not just exact match
 * - Automatic cache invalidation based on freshness requirements
 * - Memory-efficient storage with configurable limits
 */

import { crawlCache } from './crawl-cache.js';
import { auditLogger } from './observability.js';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Semantic cache entry structure
 */
export interface SemanticCacheEntry {
  /** Unique identifier for the cache entry */
  id: string;
  
  /** Original query string */
  query: string;
  
  /** Cached results data */
  results: unknown;
  
  /** Timestamp when entry was created/updated */
  createdAt: number;
  
  /** Timestamp when entry expires */
  expiresAt?: number;
  
  /** Semantic hash of the query for similarity matching */
  semanticHash: string;
}

/**
 * Semantic cache configuration
 */
export interface SemanticCacheConfig {
  /** Maximum number of entries in cache */
  maxSize?: number;
  
  /** Default TTL in milliseconds (default: 1 hour) */
  defaultTtl?: number;
  
  /** Enable/disable caching */
  enabled?: boolean;
}

// ============================================================================
// Semantic Cache Implementation
// ============================================================================

/**
 * Semantic cache for storing and retrieving search results by query meaning
 */
export class SemanticCache {
  private cache: Map<string, SemanticCacheEntry> = new Map();
  private readonly config: SemanticCacheConfig;

  constructor(config: Partial<SemanticCacheConfig> = {}) {
    this.config = {
      maxSize: config.maxSize || 1000,
      defaultTtl: config.defaultTtl || 3600000, // 1 hour
      enabled: config.enabled !== undefined ? config.enabled : true,
    };
  }

  /**
   * Compute a semantic hash for a query based on its key terms
   */
  private computeSemanticHash(query: string): string {
    // Tokenize and normalize the query
    const normalized = query.toLowerCase().replace(/[^\w\s]/g, '');
    const terms = normalized.split(/\s+/).filter(t => t.length > 0);
    
    // Sort terms for consistent hash regardless of order
    terms.sort();
    
    // Join sorted terms to create a consistent semantic signature
    return terms.join('|');
  }

  /**
   * Get a cached entry if it exists and is valid
   */
  public get(query: string): SemanticCacheEntry | null {
    if (!this.config.enabled) return null;

    const semanticHash = this.computeSemanticHash(query);
    
    // Check for exact match first
    const exactMatch = this.cache.get(semanticHash);
    if (exactMatch && !this.isExpired(exactMatch)) {
      auditLogger.logCacheHit(`query:${query}`, new Date(exactMatch.createdAt).toISOString());
      return exactMatch;
    }

    // If no exact match, check for similar queries using semantic matching
    const similarEntry = this.findSimilarEntry(query);
    if (similarEntry && !this.isExpired(similarEntry)) {
      auditLogger.logCacheHit(`similar:${query}`, new Date(similarEntry.createdAt).toISOString());
      return similarEntry;
    }

    auditLogger.logCacheMiss(`query:${query}`);
    return null;
  }

  /**
   * Store a result in the cache
   */
  public set(query: string, results: unknown, ttl?: number): void {
    if (!this.config.enabled) return;

    const semanticHash = this.computeSemanticHash(query);
    const now = Date.now();
    
    // Create new entry
    const entry: SemanticCacheEntry = {
      id: `${semanticHash}-${now}`,
      query,
      results,
      createdAt: now,
      expiresAt: ttl ? now + ttl : now + this.config.defaultTtl!,
      semanticHash,
    };

    // Evict oldest entries if cache is full
    while (this.cache.size >= this.config.maxSize!) {
      const oldestEntry = this.getOldestEntry();
      if (oldestEntry) {
        this.cache.delete(oldestEntry.id);
      } else {
        break;
      }
    }

    this.cache.set(semanticHash, entry);
    
    auditLogger.log({
      timestamp: new Date().toISOString(),
      level: 'debug',
      event: 'cache_miss',
      query: `stored:${query}`,
      metadata: { cache_size: this.cache.size },
    });
  }

  /**
   * Check if an entry has expired
   */
  private isExpired(entry: SemanticCacheEntry): boolean {
    return entry.expiresAt !== undefined && Date.now() > entry.expiresAt;
  }

  /**
   * Find a similar entry using fuzzy matching on query terms
   */
  private findSimilarEntry(query: string): SemanticCacheEntry | null {
    const queryTerms = this.tokenizeQuery(query);
    
    for (const [_, entry] of this.cache) {
      if (this.isExpired(entry)) continue;

      const entryTerms = this.tokenizeQuery(entry.query);
      
      // Calculate term overlap ratio
      const overlapRatio = this.calculateTermOverlap(queryTerms, entryTerms);
      
      // If more than 70% overlap, consider it similar enough to use cached results
      if (overlapRatio >= 0.7) {
        return entry;
      }
    }

    return null;
  }

  /**
   * Tokenize a query into terms for comparison
   */
  private tokenizeQuery(query: string): Set<string> {
    const normalized = query.toLowerCase().replace(/[^\w\s]/g, '');
    const terms = new Set(normalized.split(/\s+/).filter(t => t.length > 0));
    return terms;
  }

  /**
   * Calculate overlap ratio between two sets of terms
   */
  private calculateTermOverlap(terms1: Set<string>, terms2: Set<string>): number {
    if (terms1.size === 0 || terms2.size === 0) return 0;

    let intersection = 0;
    for (const term of terms1) {
      if (terms2.has(term)) {
        intersection++;
      }
    }

    const unionSize = Math.max(terms1.size, terms2.size);
    return unionSize > 0 ? intersection / unionSize : 0;
  }

  /**
   * Get the oldest entry in the cache
   */
  private getOldestEntry(): SemanticCacheEntry | null {
    let oldest: SemanticCacheEntry | null = null;

    for (const [_, entry] of this.cache) {
      if (!oldest || entry.createdAt < oldest.createdAt) {
        oldest = entry;
      }
    }

    return oldest;
  }

  /**
   * Clear all cache entries
   */
  public clear(): void {
    const sizeBefore = this.cache.size;
    this.cache.clear();
    
    auditLogger.log({
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'cache_miss',
      query: 'clear',
      metadata: { cleared_entries: sizeBefore },
    });
  }

  /**
   * Get cache statistics
   */
  public getStats(): {
    size: number;
    maxSize: number;
    enabled: boolean;
  } {
    return {
      size: this.cache.size,
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
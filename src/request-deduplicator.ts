/**
 * MCP Web Search - Request Deduplication Module
 *
 * Prevents concurrent duplicate API calls by tracking in-flight requests.
 * When multiple identical queries arrive simultaneously, only one makes the actual API call.
 */

interface PendingRequest<T> {
  promise: Promise<T>;
  timestamp: number;
}

/**
 * Simple in-memory deduplication store using query hash -> pending promise
 */
export class RequestDeduplicator {
  private pendingRequests: Map<string, PendingRequest<unknown>> = new Map();
  private readonly maxAgeMs: number;
  private readonly maxSize: number;

  constructor(options?: { maxAgeMs?: number; maxSize?: number }) {
    this.maxAgeMs = options?.maxAgeMs ?? 30000; // 30 seconds default
    this.maxSize = options?.maxSize ?? 200; // Cap to prevent unbounded growth
    console.log(`[RequestDeduplicator] Initialized with maxAgeMs=${this.maxAgeMs}, maxSize=${this.maxSize}`);
  }

  /**
   * Normalizes a query for consistent deduplication keys
   */
  private normalizeQuery(query: string): string {
    return query.toLowerCase().trim();
  }

  /**
   * Creates a deduplication key from query and parameters
   */
  private getDedupeKey(query: string, ...args: (string | number | boolean)[]): string {
    const normalized = this.normalizeQuery(query);
    return `${normalized}:${args.join('|')}`;
  }

  /**
   * Executes a function with request deduplication.
   * If an identical request is already in-flight, waits for it instead of making a new call.
   *
   * @param query - The search query
   * @param operation - Unique identifier for the type of operation (e.g., 'search', 'content')
   * @param fn - The async function to execute
   * @returns The result of the operation
   */
  async deduplicate<T>(
    query: string,
    operation: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const key = this.getDedupeKey(query, operation);
    const now = Date.now();

    // Clean up expired entries periodically
    this.cleanupExpired(now);

    // Check if there's already a pending request for this query+operation
    const existing = this.pendingRequests.get(key);
    if (existing) {
      const age = now - existing.timestamp;
      // Reuse the in-flight promise if it's recent enough (within 30s)
      if (age < this.maxAgeMs) {
        console.log(`[RequestDeduplicator] 🔄 Reusing in-flight request for "${query}" (${operation}) - ${age}ms old`);
        return existing.promise as Promise<T>;
      }
    }

    // Execute the actual request
    const promise = fn().finally(() => {
      // Clean up after completion or failure (but not during the waiting period)
      setTimeout(() => {
        this.cleanupExpired(Date.now());
      }, 5000); // Clean up 5 seconds after completion to allow for concurrent arrivals
    });

    // Store the pending request (with LRU eviction if at capacity)
    if (this.pendingRequests.size >= this.maxSize) {
      const oldestKey = this.pendingRequests.keys().next().value;
      if (oldestKey) this.pendingRequests.delete(oldestKey);
    }
    this.pendingRequests.set(key, {
      promise,
      timestamp: now
    });

    console.log(`[RequestDeduplicator] 🆕 New request for "${query}" (${operation})`);

    return promise;
  }

  /**
   * Cleanup expired entries to prevent memory leaks
   */
  private cleanupExpired(now: number): void {
    let cleaned = 0;
    for (const [key, entry] of this.pendingRequests.entries()) {
      if (now - entry.timestamp > this.maxAgeMs) {
        this.pendingRequests.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`[RequestDeduplicator] Cleaned up ${cleaned} expired entries (${this.pendingRequests.size} remaining)`);
    }
  }

  /**
   * Get current stats for monitoring
   */
  getStats(): { pendingCount: number } {
    return {
      pendingCount: this.pendingRequests.size
    };
  }

  /**
   * Clear all pending requests (useful for testing)
   */
  clear(): void {
    this.pendingRequests.clear();
    console.log('[RequestDeduplicator] Cleared all pending requests');
  }
}

/**
 * Global deduplicator instance - shared across the application
 */
export const requestDeduplicator = new RequestDeduplicator({
  maxAgeMs: parseInt(process.env.REQUEST_DEDUP_MAX_AGE_MS || '30000', 10)
});
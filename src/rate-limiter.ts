import pLimit from 'p-limit';

export class RateLimiter {
  private limit: ReturnType<typeof pLimit>;
  private requestCount: number = 0;
  private lastResetTime: number = Date.now();
  private readonly maxRequestsPerMinute: number;
  private readonly resetIntervalMs: number;

  constructor(maxRequestsPerMinute: number = 10, resetIntervalMs: number = 60000) {
    this.maxRequestsPerMinute = maxRequestsPerMinute;
    this.resetIntervalMs = resetIntervalMs;
    this.limit = pLimit(5); // Max 5 concurrent requests
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if we need to reset the counter
    const now = Date.now();
    if (now - this.lastResetTime >= this.resetIntervalMs) {
      this.requestCount = 0;
      this.lastResetTime = now;
    }

    // Check rate limit
    if (this.requestCount >= this.maxRequestsPerMinute) {
      const waitTime = this.resetIntervalMs - (now - this.lastResetTime);
      throw new Error(`Rate limit exceeded. Please wait ${Math.ceil(waitTime / 1000)} seconds.`);
    }

    // Increment count BEFORE queuing to ensure subsequent checks see the updated count
    this.requestCount++;

    try {
      // Execute with concurrency limit
      return await this.limit(async () => {
        return await fn();
      });
    } catch (error) {
      // If the task fails, we might want to decrement the count, 
      // but for rate limiting, it's usually better to keep it to prevent retry storms.
      // However, if it was a transient error, we might want to allow another attempt.
      // For now, let's just rethrow.
      throw error;
    }
  }

  getStatus(): { requestCount: number; maxRequests: number; resetTime: number } {
    return {
      requestCount: this.requestCount,
      maxRequests: this.maxRequestsPerMinute,
      resetTime: this.lastResetTime + this.resetIntervalMs,
    };
  }
} 
/**
 * MCP Web Search - Enterprise Guardrails Module
 * 
 * Provides advanced security features including:
 * - Per-session rate limiting with configurable limits
 * - Input validation and sanitization
 * - Output length restrictions
 * - Request throttling to prevent abuse
 */

import { auditLogger } from './observability.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Internal state for a session's rate limit tracking
 */
interface SessionRateLimitState {
  requestCount: number;
  lastResetTime: number;
  blockedUntil: number | null;
  consecutive404Count: number;
}

// ============================================================================
// Rate Limiting Configuration
// ============================================================================

/**
 * Rate limit configuration for different client types
 */
export interface RateLimitConfig {
  /** Maximum requests per minute for this session/user */
  maxRequestsPerMinute: number;
  
  /** Maximum concurrent requests allowed */
  maxConcurrentRequests: number;
  
  /** Time window in milliseconds before rate limit resets */
  resetWindowMs: number;
  
  /** Maximum input query length (characters) */
  maxInputLength: number;
  
  /** Maximum output content length (characters) */
  maxOutputLength: number;
}

/**
 * Default rate limit configuration
 */
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  maxRequestsPerMinute: 30,
  maxConcurrentRequests: 5,
  resetWindowMs: 60000,
  maxInputLength: 1000,
  maxOutputLength: 50000,
};

/**
 * Per-session rate limiter with configurable limits
 */
export class SessionRateLimiter {
  private sessions: Map<string, SessionRateLimitState> = new Map();
  private readonly config: RateLimitConfig;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = { ...DEFAULT_RATE_LIMIT_CONFIG, ...config };
  }

  /**
   * Get or create rate limit state for a session
   */
  private getSessionState(sessionId: string): SessionRateLimitState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        requestCount: 0,
        lastResetTime: Date.now(),
        blockedUntil: null,
        consecutive404Count: 0,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /**
   * Reset session state
   */
  public resetSession(sessionId: string): void {
    const state = this.getSessionState(sessionId);
    state.requestCount = 0;
    state.lastResetTime = Date.now();
    state.blockedUntil = null;
    state.consecutive404Count = 0;
    
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'rate_limit_reset',
      session_id: sessionId,
      message: 'Rate limit reset for session',
    }));
  }

  /**
   * Check if a request is allowed and record it
   */
  public async checkAndRecord(sessionId: string, toolName: string): Promise<void> {
    const state = this.getSessionState(sessionId);
    const now = Date.now();

    // Check if session is still blocked from previous rate limit hit or excessive 404s
    if (state.blockedUntil && state.blockedUntil > now) {
      const waitTime = Math.ceil((state.blockedUntil - now) / 1000);
      auditLogger.logToolError(
        toolName,
        -32009, // RateLimitExceeded
        `Session blocked. Please wait ${waitTime} seconds.`,
        'RateLimit'
      );
      throw new Error(`Session blocked. Please wait ${waitTime} seconds.`);
    }

    // Reset counter if window has passed
    if (now - state.lastResetTime >= this.config.resetWindowMs) {
      state.requestCount = 0;
      state.lastResetTime = now;
      state.blockedUntil = null;
      state.consecutive404Count = 0;
    }

    // Check rate limit
    if (state.requestCount >= this.config.maxRequestsPerMinute) {
      const waitTime = this.config.resetWindowMs - (now - state.lastResetTime);
      state.blockedUntil = now + waitTime;

      auditLogger.logToolError(
        toolName,
        -32009, // RateLimitExceeded
        `Rate limit exceeded. Please try again in ${Math.ceil(waitTime / 1000)} seconds.`,
        'RateLimit'
      );
      throw new Error(`Rate limit exceeded. Please try again in ${Math.ceil(waitTime / 1000)} seconds.`);
    }

    // Record the request
    state.requestCount++;
  }

  /**
   * Record a consecutive 404 error for a session
   */
  public record404(sessionId: string, toolName: string): void {
    const state = this.getSessionState(sessionId);
    state.consecutive404Count++;

    console.error(`[Guardrails] Consecutive 404 detected for session ${sessionId}: ${state.consecutive404Count}`);

    // If threshold reached (e.g., 3 consecutive 404s), block the session
    const threshold = 3;
    if (state.consecutive404Count >= threshold) {
      const blockDuration = 30000; // Block for 30 seconds
      state.blockedUntil = Date.now() + blockDuration;
      
      auditLogger.logToolError(
        toolName,
        -32602, // InvalidParams
        `Excessive 404 errors detected (${state.consecutive404Count}). Session temporarily blocked to prevent infinite loops.`,
        'Guardrail'
      );
      console.error(`[Guardrails] Session ${sessionId} blocked due to excessive 404s.`);
    }
  }

  /**
   * Reset consecutive 404 count for a session
   */
  public reset404(sessionId: string): void {
    const state = this.getSessionState(sessionId);
    state.consecutive404Count = 0;
  }

  /**
   * Get current rate limit status for a session
   */
  public getStatus(sessionId: string): {
    allowed: boolean;
    remainingRequests: number;
    resetTime: number;
    blockedUntil: number | null;
  } {
    const state = this.getSessionState(sessionId);
    const now = Date.now();

    // Reset if window has passed
    if (now - state.lastResetTime >= this.config.resetWindowMs) {
      state.requestCount = 0;
      state.lastResetTime = now;
    }

    return {
      allowed: !state.blockedUntil || state.blockedUntil <= now,
      remainingRequests: Math.max(0, this.config.maxRequestsPerMinute - state.requestCount),
      resetTime: state.lastResetTime + this.config.resetWindowMs,
      blockedUntil: state.blockedUntil,
    };
  }

  /**
   * Get total session count
   */
  public getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Clear all sessions (useful for testing or cleanup)
   */
  public clearAllSessions(): void {
    this.sessions.clear();
  }
}

// ============================================================================
// Input Validation & Sanitization
// ============================================================================

/**
 * Input validator for tool arguments
 */
export class InputValidator {
  private readonly config: RateLimitConfig;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = { ...DEFAULT_RATE_LIMIT_CONFIG, ...config };
  }

  /**
   * Validate and sanitize a search query
   */
  public validateQuery(query: unknown): string {
    if (typeof query !== 'string') {
      throw new Error('Invalid query: must be a string');
    }

    // Trim whitespace
    const trimmed = query.trim();
    
    // Check for empty query
    if (trimmed.length === 0) {
      throw new Error('Invalid query: cannot be empty');
    }

    // Check length limit
    if (trimmed.length > this.config.maxInputLength) {
      auditLogger.logToolError(
        'validation',
        -32602, // InvalidParams
        `Query too long: ${trimmed.length} characters (max: ${this.config.maxInputLength})`,
        'Validation'
      );
      throw new Error(`Query too long: ${trimmed.length} characters (max: ${this.config.maxInputLength})`);
    }

    return trimmed;
  }

  /**
   * Validate a limit parameter
   */
  public validateLimit(limit: unknown, min: number = 1, max: number = 20): number {
    if (limit === undefined) {
      return min; // Default to minimum
    }

    let num: number;
    if (typeof limit === 'string') {
      const parsed = parseInt(limit, 10);
      if (isNaN(parsed)) {
        throw new Error('Invalid limit: must be a number');
      }
      num = parsed;
    } else if (typeof limit === 'number') {
      num = limit;
    } else {
      throw new Error('Invalid limit: must be a number or string representing a number');
    }

    if (num < min || num > max) {
      auditLogger.logToolError(
        'validation',
        -32602, // InvalidParams
        `Invalid limit: must be between ${min} and ${max}`,
        'Validation'
      );
      throw new Error(`Invalid limit: must be between ${min} and ${max}`);
    }

    return num;
  }

  /**
   * Validate a boolean parameter (handles string-to-boolean conversion)
   */
  public validateBoolean(value: unknown, defaultValue: boolean = false): boolean {
    if (value === undefined) {
      return defaultValue;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      if (lower === 'true' || lower === 'false') {
        return lower === 'true';
      }
    }

    auditLogger.logToolError(
      'validation',
      -32602, // InvalidParams
      `Invalid boolean value: ${String(value)}`,
      'Validation'
    );
    throw new Error(`Invalid boolean value: ${String(value)}`);
  }

  /**
   * Validate a URL parameter
   */
  public validateUrl(url: unknown): string {
    if (typeof url !== 'string') {
      throw new Error('Invalid URL: must be a string');
    }

    const trimmed = url.trim();
    if (trimmed.length === 0) {
      throw new Error('Invalid URL: cannot be empty');
    }

    try {
      // Basic URL validation
      if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        auditLogger.logToolError(
          'validation',
          -32602, // InvalidParams
          `Invalid URL: must start with http:// or https://`,
          'Validation'
        );
        throw new Error('Invalid URL: must start with http:// or https://');
      }

      // Check length limit
      if (trimmed.length > this.config.maxInputLength) {
        auditLogger.logToolError(
          'validation',
          -32602, // InvalidParams
          `URL too long`,
          'Validation'
        );
        throw new Error('URL too long');
      }

      return trimmed;
    } catch (error) {
      throw error; // Re-throw validation errors
    }
  }

  /**
   * Validate and sanitize all tool arguments
   */
  public validateToolArgs(args: Record<string, unknown>, toolName: string): void {
    const allowedKeys = this.getAllowedKeys(toolName);

    for (const key of Object.keys(args)) {
      if (!allowedKeys.has(key)) {
        auditLogger.logToolError(
          'validation',
          -32602, // InvalidParams
          `Invalid argument: ${key} is not allowed`,
          'Validation'
        );
        throw new Error(`Invalid argument: ${key} is not allowed`);
      }
    }

    // Validate specific fields based on tool type
    this.validateField(args.query, 'query', 'string');
    if (args.limit !== undefined) {
      this.validateLimit(args.limit);
    }
  }

  /**
   * Get allowed keys for a specific tool
   */
  private getAllowedKeys(toolName: string): Set<string> {
    const tools = {
      'full-web-search': new Set(['query', 'limit', 'includeContent', 'maxContentLength']),
      'get-web-search-summaries': new Set(['query', 'limit']),
      'get-single-web-page-content': new Set(['url', 'maxContentLength']),
      'get-github-repo-content': new Set(['url', 'maxDepth', 'maxFiles']),
      'get-openapi-spec': new Set(['url', 'forceRefresh']),
      'progressive-web-search': new Set(['query', 'maxDepth', 'limit']),
    };

    return tools[toolName as keyof typeof tools] || new Set();
  }

  /**
   * Validate a field has the expected type
   */
  private validateField(value: unknown, fieldName: string, expectedType: string): void {
    if (value !== undefined && value !== null) {
      const actualType = typeof value;
      if (actualType !== expectedType) {
        auditLogger.logToolError(
          'validation',
          -32602, // InvalidParams
          `Invalid ${fieldName}: expected ${expectedType}, got ${actualType}`,
          'Validation'
        );
        throw new Error(`Invalid ${fieldName}: expected ${expectedType}, got ${actualType}`);
      }
    }
  }
}

// ============================================================================
// Output Length Limiter
// ============================================================================

/**
 * Limits output content length to prevent token overflow
 */
export class OutputLimiter {
  private readonly maxLength: number;

  constructor(maxLength: number = DEFAULT_RATE_LIMIT_CONFIG.maxOutputLength) {
    this.maxLength = maxLength;
  }

  /**
   * Truncate content if it exceeds the maximum length
   */
  public truncate(content: string, toolName?: string): string {
    if (content.length <= this.maxLength) {
      return content;
    }

    const truncated = content.substring(0, this.maxLength);
    
    auditLogger.logToolError(
      toolName || 'output-limit',
      -32603, // InternalError
      `Output exceeded maximum length of ${this.maxLength} characters and was truncated`,
      'Truncation'
    );

    return truncated + `\n\n[Content truncated at ${this.maxLength} characters]`;
  }

  /**
   * Check if content needs truncation
   */
  public needsTruncation(content: string): boolean {
    return content.length > this.maxLength;
  }
}

// ============================================================================
// Request Throttler (for preventing server overload)
// ============================================================================

/**
 * Global request throttler to prevent server overload
 */
export class GlobalThrottler {
  private requestTimestamps: number[] = [];
  private readonly maxRequestsPerSecond: number;
  private readonly windowMs: number;

  constructor(maxRequestsPerSecond: number = 10, windowMs: number = 1000) {
    this.maxRequestsPerSecond = maxRequestsPerSecond;
    this.windowMs = windowMs;
  }

  /**
   * Check if a request should be throttled
   */
  public async checkAndRecord(): Promise<void> {
    const now = Date.now();

    // Remove old timestamps outside the window
    this.requestTimestamps = this.requestTimestamps.filter(
      (timestamp) => now - timestamp < this.windowMs
    );

    // Check if we've exceeded the limit
    if (this.requestTimestamps.length >= this.maxRequestsPerSecond) {
      const oldestRequest = Math.min(...this.requestTimestamps);
      const waitTime = this.windowMs - (now - oldestRequest);

      auditLogger.logToolError(
        'throttling',
        -32009, // RateLimitExceeded
        `Server overloaded. Please try again in ${Math.ceil(waitTime / 1000)} seconds.`,
        'Throttling'
      );

      throw new Error(`Server overloaded. Please try again in ${Math.ceil(waitTime / 1000)} seconds.`);
    }

    // Record this request
    this.requestTimestamps.push(now);
  }
}

// ============================================================================
// Global Instances
// ============================================================================

/**
 * Default session rate limiter (30 requests/minute)
 */
export const sessionRateLimiter = new SessionRateLimiter({
  maxRequestsPerMinute: parseInt(process.env.MAX_REQUESTS_PER_MINUTE || '30', 10),
});

/**
 * Input validator with default config
 */
export const inputValidator = new InputValidator();

/**
 * Output limiter with configurable max length
 */
export const outputLimiter = new OutputLimiter(
  parseInt(process.env.MAX_OUTPUT_LENGTH || '50000', 10)
);

/**
 * Global throttler to prevent server overload (10 req/sec default)
 */
export const globalThrottler = new GlobalThrottler(
  parseInt(process.env.MAX_REQUESTS_PER_SECOND || '10', 10),
  1000
);
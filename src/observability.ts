/**
 * MCP Web Search - Observability Module
 * 
 * Provides structured audit logging, telemetry collection, and error taxonomy
 * compliant with JSON-RPC 2.0 and Model Context Protocol (MCP) specifications.
 */


// ============================================================================
// Error Codes (JSON-RPC 2.0 + MCP Extensions)
// ============================================================================

/**
 * Standard JSON-RPC 2.0 Error Codes
 */
export enum JSONRPC_ERROR_CODES {
  // Reserved for implementation-defined server errors
  ServerErrorStart = -32000,
  ServerErrorEnd = -32099,

  // Protocol-level errors
  ParseError = -32700,      // Invalid JSON was received by the server
  InvalidRequest = -32600,  // The JSON sent is not a valid Request object
  MethodNotFound = -32601,  // The method does not exist or is not available
  InvalidParams = -32602,   // Invalid method parameters
  InternalError = -32603,   // Internal JSON-RPC error

  // MCP-specific resource errors (from spec)
  ResourceNotFound = -32002,
  ResourceUnavailable = -32003,
}

/**
 * Custom MCP Error Codes for Web Search Server
 */
export enum MCP_ERROR_CODES {
  // Transport/Connection Errors
  ConnectionClosed = -32000,
  RequestTimeout = -32001,

  // Authentication/Authorization Errors
  Unauthorized = -32008,

  // Resource Exhaustion
  RateLimitExceeded = -32009,
}

// ============================================================================
// Audit Logging Types & Interfaces
// ============================================================================

/**
 * Audit event types for structured logging
 */
export type AuditEventType =
  | 'tool_call'
  | 'tool_success'
  | 'tool_error'
  | 'tool_timeout'
  | 'search_engine_select'
  | 'content_extraction'
  | 'browser_launch'
  | 'context_pool_hit'
  | 'cache_hit'
  | 'cache_miss'
  | 'cache_set'
  | 'cache_clear_requested';

/**
 * Audit log entry structure
 */
export interface AuditLogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  event: AuditEventType;
  tool?: string;
  session_id?: string;
  client_ip?: string;
  user_agent?: string;

  // Tool-specific data
  query?: string;
  search_engine?: string;
  num_results_requested?: number;
  num_results_returned?: number;
  content_length?: number;

  // Timing data
  duration_ms?: number;
  start_time?: string;
  end_time?: string;

  // Error details (for failures)
  error_code?: number;
  error_message?: string;
  error_type?: string;

  // Metadata for debugging
  metadata?: Record<string, unknown>;
}

/**
 * Telemetry metrics for monitoring
 */
export interface TelemetryMetrics {
  tool_calls: number;
  tool_successes: number;
  tool_failures: number;
  total_search_time_ms: number;
  search_engine_stats: Record<string, { calls: number; successes: number; failures: number }>;
  average_content_length: number;
  content_extraction_times: number[];
}

/**
 * Audit logger interface for structured logging
 */
export class AuditLogger {
  private readonly enabled: boolean;
  private redactedFields: Set<string>;

  constructor(enabled: boolean = true) {
    this.enabled = enabled;
    this.redactedFields = new Set(['api_key', 'token', 'password', 'secret']);
  }

  /**
   * Redact sensitive fields from an object
   */
  public redact(obj: Record<string, unknown>): Record<string, unknown> {
    if (!obj) return {};
    const result: Record<string, unknown> = { ...obj };
    for (const key of Object.keys(result)) {
      if (this.redactedFields.has(key.toLowerCase())) {
        result[key] = '[REDACTED]';
      }
    }
    return result;
  }

  /**
   * Log an audit event
   */
  public log(entry: AuditLogEntry): void {
    if (!this.enabled) return;

    const jsonLog = JSON.stringify({
      ...entry,
      metadata: entry.metadata ? this.redact(entry.metadata as any) : undefined,
    });

    // Use console.error for logs to ensure they're captured even when stdout is used for MCP
    console.error(jsonLog);
  }

  /**
   * Log a tool call event
   */
  public logToolCall(
    toolName: string,
    query?: string,
    metadata?: Record<string, unknown>
  ): void {
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'tool_call',
      tool: toolName,
      query,
      metadata,
    };
    this.log(entry);
  }

  /**
   * Log a successful tool execution
   */
  public logToolSuccess(
    toolName: string,
    durationMs: number,
    resultsCount?: number,
    contentLength?: number
  ): void {
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'tool_success',
      tool: toolName,
      duration_ms: durationMs,
      num_results_returned: resultsCount,
      content_length: contentLength,
    };
    this.log(entry);
  }

  /**
   * Log a failed tool execution
   */
  public logToolError(
    toolName: string,
    errorCode: number,
    errorMessage: string,
    errorType?: string,
    durationMs?: number
  ): void {
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'tool_error',
      tool: toolName,
      error_code: errorCode,
      error_message: errorMessage,
      error_type: errorType,
      duration_ms: durationMs,
    };
    this.log(entry);
  }

  /**
   * Log a search engine selection
   */
  public logSearchEngineSelected(engine: string, durationMs?: number): void {
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'search_engine_select',
      search_engine: engine,
      duration_ms: durationMs,
    };
    this.log(entry);
  }

  /**
   * Log a cache hit
   */
  public logCacheHit(url: string, cachedAt?: string): void {
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      level: 'debug',
      event: 'cache_hit',
      query: url,
      metadata: { cached_at: cachedAt },
    };
    this.log(entry);
  }

  /**
   * Log a cache miss
   */
  public logCacheMiss(url: string): void {
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      level: 'debug',
      event: 'cache_miss',
      query: url,
    };
    this.log(entry);
  }
}

/**
 * Telemetry collector for monitoring and alerting
 */
export class TelemetryCollector {
  private metrics: TelemetryMetrics;
  private readonly enabled: boolean;

  constructor(enabled: boolean = true) {
    this.enabled = enabled;
    this.metrics = {
      tool_calls: 0,
      tool_successes: 0,
      tool_failures: 0,
      total_search_time_ms: 0,
      search_engine_stats: {},
      average_content_length: 0,
      content_extraction_times: [],
    };
  }

  /**
   * Record a tool call
   */
  public recordToolCall(): void {
    if (!this.enabled) return;
    this.metrics.tool_calls++;
  }

  /**
   * Record a successful search
   */
  public recordSearchSuccess(engine: string, durationMs: number): void {
    if (!this.enabled) return;
    this.metrics.tool_successes++;
    this.metrics.total_search_time_ms += durationMs;

    if (!this.metrics.search_engine_stats[engine]) {
      this.metrics.search_engine_stats[engine] = { calls: 0, successes: 0, failures: 0 };
    }
    this.metrics.search_engine_stats[engine].calls++;
    this.metrics.search_engine_stats[engine].successes++;
  }

  /**
   * Record a failed search
   */
  public recordSearchFailure(engine: string, durationMs: number): void {
    if (!this.enabled) return;
    this.metrics.tool_failures++;

    if (!this.metrics.search_engine_stats[engine]) {
      this.metrics.search_engine_stats[engine] = { calls: 0, successes: 0, failures: 0 };
    }
    this.metrics.search_engine_stats[engine].calls++;
    this.metrics.search_engine_stats[engine].failures++;
  }

  /**
   * Record content extraction time
   */
  public recordContentExtraction(timeMs: number): void {
    if (!this.enabled) return;
    this.metrics.content_extraction_times.push(timeMs);
  }

  /**
   * Get current metrics as a summary object
   */
  public getMetrics(): TelemetryMetrics {
    const totalCalls = this.metrics.tool_calls || 1;
    return {
      ...this.metrics,
      average_content_length: Math.round(
        (this.metrics.total_search_time_ms / totalCalls) * 100
      ) / 100, // Simplified calculation
    };
  }

  /**
   * Get a formatted summary string for logging
   */
  public getSummary(): string {
    const m = this.getMetrics();
    const lines: string[] = [
      `=== MCP Web Search Telemetry Summary ===`,
      `Total Tool Calls: ${m.tool_calls}`,
      `Successful: ${m.tool_successes} (${Math.round((m.tool_successes / (m.tool_calls || 1)) * 100)}%)`,
      `Failed: ${m.tool_failures}`,
      `Average Search Time: ${(m.total_search_time_ms / (m.tool_calls || 1)).toFixed(2)}ms`,
    ];

    if (Object.keys(m.search_engine_stats).length > 0) {
      lines.push('\nSearch Engine Stats:');
      for (const [engine, stats] of Object.entries(m.search_engine_stats)) {
        const successRate = Math.round(
          (stats.successes / (stats.calls || 1)) * 100
        );
        lines.push(`  ${engine}: ${stats.calls} calls (${successRate}% success)`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Reset metrics for a fresh collection period
   */
  public reset(): void {
    if (!this.enabled) return;
    this.metrics = {
      tool_calls: 0,
      tool_successes: 0,
      tool_failures: 0,
      total_search_time_ms: 0,
      search_engine_stats: {},
      average_content_length: 0,
      content_extraction_times: [],
    };
  }
}

/**
 * Global instance for use across the application
 */
export const auditLogger = new AuditLogger(process.env.DEBUG_AUDIT === 'true');
export const telemetryCollector = new TelemetryCollector(true);
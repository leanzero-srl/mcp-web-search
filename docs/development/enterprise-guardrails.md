# Enterprise Guardrails Module

Rate limiting, input validation, output limiting, and security features for production use.

---

## Overview

The enterprise guardrails module provides comprehensive security and rate limiting features to protect the server from abuse and ensure stable operation in production environments.

**File**: `src/enterprise-guardrails.ts`

**Key Features**:
- Per-session rate limiting (30 requests/minute default)
- Input validation and sanitization
- Output length limiting (50KB default)
- Global request throttling

---

## Components

### 1. Session Rate Limiter

Tracks and limits requests per client session/user.

```typescript
import { sessionRateLimiter } from './enterprise-guardrails.js';

// Check if request is allowed
const allowed = await sessionRateLimiter.checkLimit(sessionId);
if (!allowed) {
  throw new Error('Rate limit exceeded');
}
```

**Configuration**:
- Default: 30 requests per minute
- Configurable via `MAX_REQUESTS_PER_MINUTE` env var

### 2. Input Validator

Validates all tool arguments before processing.

```typescript
import { inputValidator } from './enterprise-guardrails.js';

// Validate full-web-search arguments
inputValidator.validate('full-web-search', args);
```

**Validated Fields**:
- `query`: Non-empty string, max length (default: 1000 chars)
- `limit`: Number between 1-10
- `includeContent`: Boolean or boolean-like string
- `url`: Must start with http:// or https://

### 3. Output Limiter

Prevents token overflow by limiting output size.

```typescript
import { outputLimiter } from './enterprise-guardrails.js';

// Limit content length
const limited = outputLimiter.limit(content, maxLength);
```

**Configuration**:
- Default: 50000 characters
- Configurable via `MAX_OUTPUT_LENGTH` env var

### 4. Global Throttler

Prevents server overload from too many concurrent requests.

```typescript
import { globalThrottler } from './enterprise-guardrails.js';

// Check if request can proceed
await globalThrottler.acquire();
try {
  // Process request
} finally {
  globalThrottler.release();
}
```

**Configuration**:
- Default: 10 requests per second
- Configurable via `MAX_REQUESTS_PER_SECOND` env var

---

## Integration with Tools

All tools automatically use guardrails through the tool handler:

```typescript
// From src/index.ts - full-web-search tool
async (args: unknown) => {
  // Guardrails are applied automatically:
  // 1. Session rate limiting checked
  // 2. Input validated via Zod schemas
  // 3. Output length managed in response formatting
  
  try {
    const result = await this.handleWebSearch(validatedArgs);
    return { content: [{ type: 'text', text: responseText }] };
  } catch (error) {
    this.handleError(error, 'full-web-search');
  }
}
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_REQUESTS_PER_MINUTE` | 30 | Per-session rate limit |
| `MAX_OUTPUT_LENGTH` | 50000 | Maximum output characters |
| `MAX_REQUESTS_PER_SECOND` | 10 | Global request rate |

### Rate Limiter Settings

```typescript
// Default settings (can be overridden via env vars)
const RATE_LIMIT_SETTINGS = {
  maxRequests: 30,
  windowMs: 60 * 1000, // 1 minute
};
```

---

## Error Responses

When guardrails are exceeded, appropriate error codes are returned:

| Condition | Error Code | Message |
|-----------|------------|---------|
| Rate limit exceeded | -32009 | "Rate limit exceeded" |
| Invalid parameters | -32602 | "Invalid parameters: ..." |
| Request timeout | -32001 | "Request timeout" |

---

## Testing

Test files: `tests/integration/rate-limiter.test.ts`

**Key Tests**:
- Session rate limiting enforcement
- Input validation rejection
- Output length truncation
- Global throttling behavior

---

## Production Recommendations

### For High-Traffic Environments

1. **Increase Rate Limits**: Set higher `MAX_REQUESTS_PER_MINUTE`
2. **Adjust Throttling**: Tune `MAX_REQUESTS_PER_SECOND` based on capacity
3. **Monitor Metrics**: Use telemetry to track rate limit hits

### For Development

1. **Lower Limits**: Use stricter limits during development testing
2. **Enable Debug Logging**: Set `DEBUG_AUDIT=true`
3. **Clear Sessions**: Use debug endpoints to reset state

---

## Session Management

Sessions are automatically created and managed:

```typescript
// Generate session ID (used for rate limiting)
const sessionId = `${clientId}-${Date.now()}`;
```

### Session Cleanup

- Sessions are cleaned up after inactivity timeout
- Total session count tracked for monitoring
- Debug endpoint available to clear all sessions

---

## Security Features

1. **Input Sanitization**: All user inputs validated and sanitized
2. **Rate Limiting**: Prevents abuse and DoS attacks
3. **Output Limiting**: Prevents token exhaustion attacks
4. **Structured Logging**: All actions logged for audit trail

---

## Debugging and Monitoring

### Enable Audit Logging

```bash
export DEBUG_AUDIT=true
```

### View Rate Limit Status

```typescript
// Via telemetry, rate limit hits are tracked
telemetryCollector.recordRateLimitHit(sessionId);
```

### Clear Session Data (Debug)

For testing purposes:
```typescript
sessionRateLimiter.clearSession(sessionId);
globalThrottler.reset();
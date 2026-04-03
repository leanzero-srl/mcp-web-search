# Environment Variables Reference

Complete list of all environment variables for configuring the Web Search MCP Server.

---

## Quick Reference Table

| Category | Variable | Default | Description |
|----------|----------|---------|-------------|
| **Basic** | `MAX_CONTENT_LENGTH` | 500000 | Maximum content length in characters |
| **Basic** | `DEFAULT_TIMEOUT` | 6000 | Request timeout in milliseconds |
| **Basic** | `MIN_CONTENT_LENGTH` | 200 | Minimum content length for valid results |
| **Browser** | `MAX_BROWSERS` | 3 | Maximum browser instances to maintain |
| **Browser** | `BROWSER_TYPES` | webkit,chromium,firefox | Browser types to use (comma-separated) |
| **Browser** | `BROWSER_HEADLESS` | true | Enable headless mode for browsers |
| **Context Pool** | `CONTEXT_POOL_SIZE` | 10 | Maximum contexts in the pool |
| **Context Pool** | `CONTEXT_REUSE_TIMEOUT` | 30000 | Context stale timeout in ms |
| **Context Pool** | `CONTEXT_MAX_AGE` | 60000 | Max context age before refresh in ms |
| **Search Quality** | `ENABLE_RELEVANCE_CHECKING` | true | Enable search result quality validation |
| **Search Quality** | `RELEVANCE_THRESHOLD` | 0.3 | Minimum relevance score (0-1) |
| **Search Quality** | `FORCE_MULTI_ENGINE_SEARCH` | false | Try all engines and return best results |
| **Performance** | `BROWSER_FALLBACK_THRESHOLD` | 3 | Axios failures before browser fallback |
| **Performance** | `DEBUG_BROWSER_LIFECYCLE` | false | Enable detailed browser lifecycle logging |
| **Observability** | `DEBUG_AUDIT` | false | Enable structured audit logging to stderr |
| **Rate Limiting** | `MAX_REQUESTS_PER_MINUTE` | 30 | Max requests per minute per session |
| **Output** | `MAX_OUTPUT_LENGTH` | 50000 | Max output content length in characters |
| **Throttling** | `MAX_REQUESTS_PER_SECOND` | 10 | Max global requests per second |

---

## Detailed Configuration

### Basic Configuration

#### MAX_CONTENT_LENGTH
Maximum content length in characters for extracted content.

```bash
# Default: 500000 (500KB)
export MAX_CONTENT_LENGTH=1000000
```

**Valid Range**: Positive integers  
**Impact**: Higher values allow more content but increase memory usage

#### DEFAULT_TIMEOUT
Default timeout for requests in milliseconds.

```bash
# Default: 6000ms (6 seconds)
export DEFAULT_TIMEOUT=10000
```

**Valid Range**: 1000-60000  
**Recommendation**: Increase for slow websites, decrease for faster responses

#### MIN_CONTENT_LENGTH
Minimum content length required for valid results.

```bash
# Default: 200 characters
export MIN_CONTENT_LENGTH=300
```

**Valid Range**: Positive integers  
**Impact**: Higher values ensure more complete content but may increase extraction time

---

### Browser Configuration

#### MAX_BROWSERS
Maximum number of browser instances to maintain in the pool.

```bash
# Default: 3 browsers
export MAX_BROWSERS=5
```

**Valid Range**: 1-20  
**Trade-offs**:
- Lower = less memory, slower context reuse
- Higher = more memory, faster parallel searches

#### BROWSER_TYPES
Comma-separated list of browser types to use.

```bash
# Default: webkit,chromium,firefox
export BROWSER_TYPES=webkit,chromium
```

**Available Options**: `webkit`, `chromium`, `firefox`  
**Order Matters**: First available browser is used first

#### BROWSER_HEADLESS
Enable headless mode for browsers.

```bash
# Default: true (server environments)
export BROWSER_HEADLESS=false  # For debugging with visible browser
```

**Valid Values**: `true`, `false`

---

### Context Pool Configuration

#### CONTEXT_POOL_SIZE
Maximum number of contexts in the pool.

```bash
# Default: 10 contexts
export CONTEXT_POOL_SIZE=5
```

**Valid Range**: 1-50  
**Trade-offs**:
- Lower = less memory usage, fewer concurrent searches possible
- Higher = more memory, better parallel performance

#### CONTEXT_REUSE_TIMEOUT
Time in milliseconds before context is considered stale.

```bash
# Default: 30000ms (30 seconds)
export CONTEXT_REUSE_TIMEOUT=60000
```

**Valid Range**: 5000-120000  
**Impact**: Longer timeouts = more reuse, potential for stale contexts

#### CONTEXT_MAX_AGE
Maximum age of context in milliseconds before forced refresh.

```bash
# Default: 60000ms (60 seconds)
export CONTEXT_MAX_AGE=90000
```

**Valid Range**: 10000-300000  
**Impact**: Shorter = fresher contexts, longer = more reuse

---

### Search Quality and Engine Selection

#### ENABLE_RELEVANCE_CHECKING
Enable/disable search result quality validation.

```bash
# Default: true
export ENABLE_RELEVANCE_CHECKING=false  # Disable for all results
```

**Valid Values**: `true`, `false`  
**Impact**: Disabled may return more results but with lower quality

#### RELEVANCE_THRESHOLD
Minimum relevance score for search results (0.0 to 1.0).

```bash
# Default: 0.3 (30%)
export RELEVANCE_THRESHOLD=0.5  # Stricter filtering
```

**Valid Range**: 0.0-1.0  
**Trade-offs**:
- Lower = more results, potentially lower quality
- Higher = fewer but more relevant results

#### FORCE_MULTI_ENGINE_SEARCH
Try all search engines and return the best results.

```bash
# Default: false (first successful engine)
export FORCE_MULTI_ENGINE_SEARCH=true
```

**Valid Values**: `true`, `false`  
**Impact**: true = slower but potentially better results

---

### Performance Tuning

#### BROWSER_FALLBACK_THRESHOLD
Number of axios failures before using browser fallback.

```bash
# Default: 3 failures
export BROWSER_FALLBACK_THRESHOLD=5
```

**Valid Range**: 1-10  
**Trade-offs**:
- Lower = faster fallback, more browser usage
- Higher = fewer browser attempts, potentially missed content

#### DEBUG_BROWSER_LIFECYCLE
Enable detailed browser lifecycle logging for debugging.

```bash
# Default: false (production)
export DEBUG_BROWSER_LIFECYCLE=true  # Enable for troubleshooting
```

**Valid Values**: `true`, `false`  
**Note**: Increases log verbosity significantly

---

### Observability Configuration

#### DEBUG_AUDIT
Enable structured audit logging to stderr.

```bash
# Default: false (disabled by default)
export DEBUG_AUDIT=true
```

**Valid Values**: `true`, `false`  
**Log Format**: JSON with timestamp, level, event type, and details

**Example Log Entry**:
```json
{
  "timestamp": "2025-04-03T10:00:00.000Z",
  "level": "info",
  "event": "tool_call",
  "tool": "full-web-search",
  "query": "search query",
  "duration_ms": 1250
}
```

---

### Enterprise Guardrails Configuration

#### MAX_REQUESTS_PER_MINUTE
Maximum requests per minute per session/user.

```bash
# Default: 30 requests/minute
export MAX_REQUESTS_PER_MINUTE=60
```

**Valid Range**: Positive integers  
**Impact**: Higher values allow more API usage but increase server load

#### MAX_OUTPUT_LENGTH
Maximum output content length in characters.

```bash
# Default: 50000 characters (50KB)
export MAX_OUTPUT_LENGTH=100000
```

**Valid Range**: Positive integers  
**Impact**: Prevents token overflow in LLM responses

#### MAX_REQUESTS_PER_SECOND
Maximum global requests per second.

```bash
# Default: 10 requests/second
export MAX_REQUESTS_PER_SECOND=20
```

**Valid Range**: Positive integers  
**Impact**: Controls overall server load and prevents overload

---

## Environment File (.env)

Create a `.env` file in the project root:

```bash
# Example .env file

# Basic settings
MAX_CONTENT_LENGTH=500000
DEFAULT_TIMEOUT=6000
MIN_CONTENT_LENGTH=200

# Browser configuration
MAX_BROWSERS=3
BROWSER_TYPES=webkit,chromium,firefox
BROWSER_HEADLESS=true

# Context pool
CONTEXT_POOL_SIZE=10
CONTEXT_REUSE_TIMEOUT=30000
CONTEXT_MAX_AGE=60000

# Search quality
ENABLE_RELEVANCE_CHECKING=true
RELEVANCE_THRESHOLD=0.3
FORCE_MULTI_ENGINE_SEARCH=false

# Performance tuning
BROWSER_FALLBACK_THRESHOLD=3
DEBUG_BROWSER_LIFECYCLE=false

# Observability
DEBUG_AUDIT=false

# Enterprise guardrails
MAX_REQUESTS_PER_MINUTE=30
MAX_OUTPUT_LENGTH=50000
MAX_REQUESTS_PER_SECOND=10
```

---

## Setting Environment Variables

### macOS/Linux

```bash
export VARIABLE_NAME=value
npm start
```

Or directly:

```bash
VARIABLE_NAME=value npm start
```

### Windows (Command Prompt)

```cmd
set VARIABLE_NAME=value
npm start
```

### Windows (PowerShell)

```powershell
$env:VARIABLE_NAME = "value"
npm start
```

---

## Default Values Summary

| Setting | Default |
|---------|---------|
| Max Content Length | 500,000 chars |
| Timeout | 6,000 ms |
| Min Content Length | 200 chars |
| Max Browsers | 3 |
| Browser Types | webkit,chromium,firefox |
| Context Pool Size | 10 |
| Context Reuse Timeout | 30,000 ms |
| Context Max Age | 60,000 ms |
| Rate Limit (per minute) | 30 requests |
| Output Length Limit | 50,000 chars |
| Global Rate Limit | 10 req/sec |

---

## Recommended Settings by Use Case

### Development
```bash
DEBUG_AUDIT=true
BROWSER_HEADLESS=false
```

### High-Traffic Production
```bash
MAX_BROWSERS=5
CONTEXT_POOL_SIZE=20
MAX_REQUESTS_PER_MINUTE=60
MAX_REQUESTS_PER_SECOND=20
```

### Resource-Constrained Environment
```bash
MAX_BROWSERS=1
CONTEXT_POOL_SIZE=3
DEFAULT_TIMEOUT=4000
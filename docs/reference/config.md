# Configuration Reference

Complete guide to configuring the Web Search MCP Server.

---

## Quick Start

### Default Configuration

The server works out of the box with sensible defaults. No configuration required for basic usage.

```bash
npm install
npx playwright install
npm run build
```

### Custom Configuration

Create a `.env` file in the project root:

```bash
MAX_CONTENT_LENGTH=1000000
DEFAULT_TIMEOUT=10000
DEBUG_AUDIT=true
```

---

## Configuration Layers

Configuration is applied in order (later overrides earlier):

```
1. Default Values (hardcoded)
     ↓
2. Environment Variables (.env file or system env)
     ↓  
3. Client-Side Parameters (tool arguments)
```

### Override Priority Example

```bash
# .env file sets:
MAX_CONTENT_LENGTH=500000

# Tool argument overrides:
{
  "name": "full-web-search",
  "arguments": {
    "maxContentLength": 1000000,  # This wins!
    ...
  }
}
```

---

## Configuration Sources

### 1. Default Values

Built into the source code. Used when no other configuration is provided.

| Setting | Default |
|---------|---------|
| `MAX_CONTENT_LENGTH` | 500000 |
| `DEFAULT_TIMEOUT` | 6000 |
| `MIN_CONTENT_LENGTH` | 200 |
| `CONTEXT_POOL_SIZE` | 10 |

### 2. Environment Variables

Set via `.env` file or system environment.

**Example .env file**:
```bash
# Basic settings
MAX_CONTENT_LENGTH=500000
DEFAULT_TIMEOUT=6000

# Browser configuration  
MAX_BROWSERS=3
BROWSER_TYPES=webkit,chromium,firefox

# Rate limiting
MAX_REQUESTS_PER_MINUTE=30
```

### 3. Client-Side Parameters

Passed when calling tools:

```json
{
  "name": "full-web-search",
  "arguments": {
    "limit": 10,
    "maxContentLength": 2000
  }
}
```

---

## Configuration Files

### package.json

Project metadata and scripts:

```json
{
  "name": "web-search-mcp-server",
  "version": "0.3.1",
  "scripts": {
    "build": "tsc && echo 'Build complete'",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run"
  }
}
```

### tsconfig.json

TypeScript compiler configuration:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "outDir": "./dist",
    "strict": true,
    "esModuleInterop": true
  },
  "include": ["src/**/*"]
}
```

### .prettierrc / .eslintrc.json

Code formatting and linting rules.

---

## Browser Configuration

### Playwright Configuration

Browsers are configured via environment variables:

```bash
export BROWSER_TYPES=webkit,chromium,firefox
export MAX_BROWSERS=5
export BROWSER_HEADLESS=true
```

### Headless Mode

**Production (default)**:
```bash
BROWSER_HEADLESS=true
```

**Development (visible browser)**:
```bash
BROWSER_HEADLESS=false
npx playwright install-deps  # May be needed for visible mode
```

---

## Context Pool Configuration

The context pool reuses browser contexts for better performance.

### Optimal Settings

| Environment | Pool Size | Reuse Timeout |
|-------------|-----------|---------------|
| Development | 3-5 | 30s |
| Production (low traffic) | 5-10 | 30s |
| Production (high traffic) | 10-20 | 60s |

### Example Configuration

```bash
CONTEXT_POOL_SIZE=10
CONTEXT_REUSE_TIMEOUT=30000
CONTEXT_MAX_AGE=60000
```

---

## Rate Limiting Configuration

Configure per-session and global rate limits:

```bash
# Per session (per client)
MAX_REQUESTS_PER_MINUTE=30

# Global (server-wide)
MAX_REQUESTS_PER_SECOND=10
```

### Default Behavior

- **New sessions**: Start with 0 requests counted
- **Rate limit exceeded**: All subsequent requests rejected until reset
- **Session timeout**: Reset after no activity for configured time

---

## Content Extraction Configuration

### Timeout Settings

```bash
# Global default timeout
DEFAULT_TIMEOUT=6000

# For single page extraction (may need more time)
maxContentLength in tool arguments
```

### Quality Thresholds

```bash
# Minimum content length to consider valid
MIN_CONTENT_LENGTH=200

# Relevance threshold for search results
RELEVANCE_THRESHOLD=0.3
```

---

## Observability Configuration

### Audit Logging

```bash
DEBUG_AUDIT=true
```

**Log format**:
```json
{
  "timestamp": "2025-04-03T10:00:00.000Z",
  "level": "info|error",
  "event": "tool_call|tool_success|tool_error",
  "tool": "full-web-search",
  "query": "search query"
}
```

### Debug Browser Lifecycle

```bash
DEBUG_BROWSER_LIFECYCLE=true
```

---

## MCP Server Configuration (mcp.json)

If using with an MCP client:

```json
{
  "mcpServers": {
    "web-search": {
      "command": "node",
      "args": ["/path/to/web-search-mcp/dist/index.js"],
      "env": {
        "MAX_CONTENT_LENGTH": "500000",
        "DEFAULT_TIMEOUT": "6000"
      }
    }
  }
}
```

### LibreChat Configuration

```yaml
mcpServers:
  web-search:
    type: stdio
    command: node
    args:
      - /app/mcp/web-search-mcp/dist/index.js
    serverInstructions: true
```

---

## Performance Tuning

### Fast Response (Low Latency)

```bash
MAX_BROWSERS=1
CONTEXT_POOL_SIZE=3
DEFAULT_TIMEOUT=4000
BROWSER_FALLBACK_THRESHOLD=2
```

### High Throughput (Many Requests)

```bash
MAX_BROWSERS=5
CONTEXT_POOL_SIZE=20
MAX_REQUESTS_PER_MINUTE=60
MAX_REQUESTS_PER_SECOND=20
```

### Resource Constrained

```bash
MAX_BROWSERS=1
CONTEXT_POOL_SIZE=3
DEFAULT_TIMEOUT=8000
MAX_CONTENT_LENGTH=100000
```

---

## Environment Variable Quick Reference

| Variable | Default | Recommended Range |
|----------|---------|-------------------|
| `MAX_CONTENT_LENGTH` | 500000 | 10000-1000000 |
| `DEFAULT_TIMEOUT` | 6000 | 4000-15000 |
| `MIN_CONTENT_LENGTH` | 200 | 100-500 |
| `MAX_BROWSERS` | 3 | 1-20 |
| `CONTEXT_POOL_SIZE` | 10 | 3-30 |
| `CONTEXT_REUSE_TIMEOUT` | 30000 | 10000-60000 |
| `RELEVANCE_THRESHOLD` | 0.3 | 0.1-0.8 |
| `MAX_REQUESTS_PER_MINUTE` | 30 | 5-100 |
| `MAX_OUTPUT_LENGTH` | 50000 | 10000-200000 |

---

## Configuration Validation

The server validates all configuration:

- Invalid numbers rejected
- Out-of-range values use defaults
- Invalid browser types ignored with warning

**Validation errors are logged to stderr**

---

## Testing Different Configurations

### Quick Test

```bash
# Test with different timeout
DEFAULT_TIMEOUT=10000 npm test

# Test with debug logging
DEBUG_AUDIT=true DEBUG_BROWSER_LIFECYCLE=true npm run dev
```

### Production Checklist

- [ ] `BROWSER_HEADLESS=true`
- [ ] `MAX_BROWSERS` adjusted for traffic
- [ ] `MAX_REQUESTS_PER_MINUTE` set appropriately
- [ ] `DEBUG_AUDIT=false` (or redirect logs)
- [ ] Environment variables stored securely
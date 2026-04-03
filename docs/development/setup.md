# Development Setup Guide

How to set up the project for local development and contribution.

---

## Prerequisites

| Tool | Required Version |
|------|------------------|
| Node.js | 18.0.0 or higher |
| npm | 8.0.0 or higher |
| git | Any recent version |

### Verify Installation

```bash
node --version   # Should be v18+  
npm --version    # Should be v8+
```

---

## Quick Start

```bash
# Clone the repository
git clone https://github.com/mrkrsl/web-search-mcp.git
cd web-search-mcp

# Install dependencies
npm install

# Install Playwright browsers
npx playwright install

# Build the project
npm run build

# Verify installation
node ./dist/index.js --version
```

---

## Development Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Development with hot reload (uses tsx) |
| `npm run build` | Compile TypeScript to JavaScript |
| `npm run lint` | Run ESLint on source files |
| `npm run format` | Format code with Prettier |
| `npm test` | Run unit tests |
| `npm run test:integration` | Run integration tests |

---

## Project Structure

```
mcp-web-search/
├── src/                      # Source code (TypeScript)
│   ├── index.ts             # Main entry point & MCP tools
│   ├── search-engine.ts     # Multi-engine search orchestration
│   ├── browser-pool.ts      # Browser context pooling
│   ├── content-extractor.ts # Web page extraction logic
│   ├── pdf-extractor.ts     # PDF content extraction
│   ├── semantic-cache.ts    # Semantic caching layer
│   ├── progressive-search-engine.ts  # Query expansion system
│   ├── query-intent-detector.ts      # Intent detection
│   ├── semantic-expander.ts          # Query expansion
│   ├── github-extractor.ts           # GitHub crawler
│   ├── openapi-extractor.ts          # OpenAPI spec extraction
│   ├── enterprise-guardrails.ts      # Rate limiting & validation
│   ├── observability.ts              # Logging & telemetry
│   ├── browser-engine.ts             # Browser interaction
│   ├── context-pool.ts               # Context management
│   ├── crawl-cache.ts                # URL caching
│   ├── rate-limiter.ts               # Rate limiting logic
│   ├── types.ts                      # Type definitions
│   └── utils.ts                      # Utility functions
├── tests/                    # Test files
│   ├── integration/         # Integration tests
│   ├── setup/               # Test utilities
│   └── *.mjs                # Simple test scripts
├── dist/                     # Compiled JavaScript (generated)
├── docs/                     # Documentation
└── scripts/                  # Build and deployment scripts
```

---

## Code Style

### TypeScript Configuration

**Target**: ES2022  
**Module**: ESNext  
**Output Directory**: `./dist`  
**Root Directory**: `./src`

See `tsconfig.json` for full configuration.

### Linting

The project uses ESLint with TypeScript support. Run before committing:

```bash
npm run lint
```

### Formatting

Format all code with Prettier before committing:

```bash
npm run format
```

---

## Testing Strategy

### Unit Tests

Run all unit tests:
```bash
npm test
```

### Integration Tests

Run integration tests (includes actual browser automation):
```bash
npm run test:integration
```

### Test Coverage

Generate coverage report:
```bash
npm run test:coverage
```

---

## Debugging

### Enable Audit Logging

Set environment variable to enable structured JSON logging:

```bash
export DEBUG_AUDIT=true
node ./dist/index.js
```

### Log Format

All tool calls and errors are logged in JSON format to stderr:
```json
{
  "timestamp": "2025-04-03T10:00:00.000Z",
  "level": "info|error",
  "event": "tool_call|tool_success|tool_error",
  "tool": "full-web-search",
  "query": "search query",
  "duration_ms": 1250
}
```

### Debug Browser Lifecycle

Enable detailed browser lifecycle logging:
```bash
export DEBUG_BROWSER_LIFECYCLE=true
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_CONTENT_LENGTH` | 500000 | Maximum content length in chars |
| `DEFAULT_TIMEOUT` | 6000 | Timeout in ms |
| `MAX_BROWSERS` | 3 | Maximum browser instances |
| `CONTEXT_POOL_SIZE` | 10 | Context pool size |
| `SEMANTIC_CACHE_MAX_SIZE` | 1000 | Max cache entries |
| `SEMANTIC_CACHE_TTL` | 3600000 | Cache TTL in ms |

See `mcp-web-search/README.md` for complete environment variable list.

---

## Browser Configuration

### Playwright Installation

Install browsers after npm install:
```bash
npx playwright install
```

### Browser Types

Available browser types (in order of preference):
1. **webkit** - Fastest, recommended default
2. **chromium** - Full Chrome compatibility
3. **firefox** - Fallback option

Set via environment variable:
```bash
export BROWSER_TYPES=webkit,chromium,firefox
```

---

## Common Development Tasks

### Adding a New MCP Tool

1. Add tool definition in `src/index.ts`
2. Implement handler function
3. Test with integration tests
4. Document in `docs/tools/`

See `docs/development/adding-new-tools.md` for detailed guide.

### Modifying Search Behavior

**Files to modify**:
- `src/search-engine.ts` - Core search logic
- `src/browser-pool.ts` - Browser management
- `src/context-pool.ts` - Context pool settings

### Changing Rate Limits

**File**: `src/enterprise-guardrails.ts`

Modify rate limiter configuration in constructor or via env vars.

---

## Troubleshooting

### npm install Fails

**Issue**: Node version too old  
**Solution**: Upgrade to Node.js 18+

```bash
# Using nvm
nvm install 18
nvm use 18
```

### playwright install Fails

**Issue**: Missing system dependencies  
**Solution**: Install required packages

On macOS:
```bash
brew install cairo pango libpng jpeg giflib
```

### Build Errors

**Issue**: TypeScript compilation errors  
**Solution**: Clean and rebuild

```bash
rm -rf dist node_modules/.cache
npm run build
```

---

## Contributing Checklist

Before submitting PR:

- [ ] Code passes linting (`npm run lint`)
- [ ] Code is formatted (`npm run format`)
- [ ] Tests pass (`npm test`)
- [ ] Documentation updated if needed
- [ ] Version bumped in `package.json` if public API changed

---

## Next Steps

1. Read `docs/architecture/overview.md` to understand system design
2. Check `docs/tools/tool-reference.md` for tool documentation
3. Explore integration tests for usage examples
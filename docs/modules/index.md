# Module Documentation

Detailed documentation for each feature module in the Web Search MCP Server.

---

## Overview

The server is built as a modular system with independent components that work together:

```
┌─────────────────────────────────────────────────────────────┐
│                   MCP Protocol Layer                        │
│  (src/index.ts - Tool handlers)                             │
└──────────────────┬──────────────────────────────────────────┘
                   │
     ┌─────────────┼─────────────┐
     ▼             ▼             ▼
┌─────────┐   ┌─────────┐   ┌──────────────┐
│Search   │   │Content  │   │Enterprise    │
│Engine   │   │Extractor│   │Guardrails    │
└────┬────┘   └────┬────┘   └──────┬───────┘
     │             │               │
     │      ┌──────┴──────┐        │
     │      ▼             ▼        │
     │  ┌──────────────────────┐   │
     │  │Browser Pool          │   │
     │  │Context Pool          │   │
     │  └──────────────────────┘   │
     │                             │
     └─────────────┬───────────────┘
                   ▼
        ┌────────────────────┐
        │Progressive Search  │
        │Semantic Cache      │
        └────────────────────┘
```

---

## Module Reference

| Module | File | Description |
|--------|------|-------------|
| **Search Engine** | `src/search-engine.ts` | Multi-engine parallel search (Bing, Brave, DDG) |
| **Browser Pool** | `src/browser-pool.ts` | Reusable browser context management |
| **Content Extractor** | `src/content-extractor.ts` | Web page content extraction |
| **Enhanced Content** | `src/enhanced-content-extractor.ts` | Advanced extraction with fallbacks |
| **PDF Extractor** | `src/pdf-extractor.ts` | PDF text extraction (HTTP + browser) |
| **Semantic Cache** | `src/semantic-cache.ts` | Semantic similarity-based caching |
| **Progressive Search** | `src/progressive-search-engine.ts` | Query expansion system |
| **GitHub Extractor** | `src/github-extractor.ts` | GitHub repository crawler |
| **OpenAPI Extractor** | `src/openapi-extractor.ts` | OpenAPI specification downloader |
| **Enterprise Guardrails** | `src/enterprise-guardrails.ts` | Rate limiting & validation |
| **Observability** | `src/observability.ts` | Logging & telemetry |
| **Browser Engine** | `src/browser-engine.ts` | Browser interaction utilities |
| **Context Pool** | `src/context-pool.ts` | Context lifecycle management |
| **Crawl Cache** | `src/crawl-cache.ts` | URL caching for repeated requests |
| **Rate Limiter** | `src/rate-limiter.ts` | Rate limiting logic |

---

## Feature Modules Documentation

### [PDF Extractor](./pdf-extractor.md)

Extract and return text content from PDF documents.

- Two-stage extraction (HTTP + browser fallback)
- Automatic quality validation
- Content truncation for token management

**When to use**: Extracting research papers, documentation, or any PDF content.

---

### [Semantic Cache](./semantic-cache.md)

Intelligent caching with semantic similarity matching for repeated and related queries.

- Query meaning matching (not just exact matches)
- TTL-based expiration
- LRU eviction when cache is full

**When to use**: Repeated searches, related queries, development/testing.

---

## Core Modules

### Search Engine (`src/search-engine.ts`)

The heart of the web search functionality. Supports:

- **Parallel engine attempts** via `Promise.race()`
- **Bing** (Chromium browser)
- **Brave** (Firefox browser)  
- **DuckDuckGo** (axios HTTP requests)
- **Automatic fallback** to faster engines

### Browser Pool (`src/browser-pool.ts`)

Manages reusable browser contexts:

- **Context reuse**: ~50ms vs fresh launch ~500ms
- **Concurrency control**: Configurable via `MAX_BROWSERS`
- **Cleanup**: Automatic stale context removal

### Content Extractor (`src/content-extractor.ts`)

Extracts text content from web pages:

- **Main content extraction** with DOM analysis
- **Quality validation** (min 200 chars)
- **HTTP/2 to HTTP/1.1 fallback**

## Development Modules

### Progressive Search Engine

Expands queries automatically when good results aren't found:

- **Stage 1**: Literal search with original query
- **Stage 2+**: Semantic expansion (synonyms, related terms)
- **Stage 3+**: Topic deepening (related concepts)

### GitHub Extractor

Crawls GitHub repositories and extracts content:

- **Directory traversal** with configurable depth
- **File filtering** by type (.js, .ts, .py, etc.)
- **README extraction**

## Enterprise Modules

### Rate Limiter

Prevents abuse with session-based rate limiting:

- **Per-session tracking**: Configurable via `MAX_REQUESTS_PER_MINUTE`
- **Global throttling**: Configurable via `MAX_REQUESTS_PER_SECOND`

### Enterprise Guardrails

Comprehensive security features:

- Input validation and sanitization
- Output length limiting (50KB default)
- Audit logging

---

## Module Architecture Details

### Data Flow

```
User Query → Tool Handler → Validation → 
    → Search Engine → Content Extraction → Quality Check → Response
```

### Error Handling

Each module has specific error handling:

| Module | Error Types | Recovery Strategy |
|--------|-------------|-------------------|
| Search Engine | Timeout, network errors | Browser fallback, retry with different engine |
| Browser Pool | Launch failures | Context reuse, cleanup stale contexts |
| Content Extractor | DOM parsing errors | Fallback extraction methods |

---

## Performance Characteristics

| Operation | Typical Time | Notes |
|-----------|-------------|-------|
| Context reuse | ~10-50ms | From browser context pool |
| Browser launch (fresh) | ~500ms | Not used in production due to pool |
| Search request | ~3-4s | Parallel engine attempts |
| Content extraction | ~2-6s per URL | Depends on page complexity |
| PDF extraction (HTTP) | ~1-3s | Fast direct download |
| PDF extraction (browser) | ~5-10s | Fallback for complex PDFs |

---

## Testing

Each module has dedicated test coverage:

| Module | Test File |
|--------|-----------|
| Search Engine | `tests/integration/*.test.ts` |
| Browser Pool | Integration tests |
| Content Extractor | Integration tests |
| PDF Extractor | `tests/integration/pdf-integration.test.ts` |
| Semantic Cache | `tests/integration/semantic-cache.test.ts` |

Run tests:
```bash
npm test                    # Unit tests
npm run test:integration   # Integration tests
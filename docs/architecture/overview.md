# System Architecture Overview

This document describes the high-level architecture of the Web Search MCP Server, including component relationships and data flow.

---

## Architecture Diagram (Text-Based)

```
┌─────────────────────────────────────────────────────────────────┐
│                    MCP Protocol Layer                           │
│  ┌──────────────┬──────────────┬──────────────┬──────────────┐  │
│  │ full-web-    │ get-web-     │ get-single-  │ progressive- │  │
│  │ search       │ search-      │ web-page-    │ web-search   │  │
│  └──────────────┴──────────────┴──────────────┴──────────────┘  │
│  ┌──────────────┬──────────────┬──────────────┬──────────────┐  │
│  │ cached-web-  │ get-github-  │ get-pdf-     │ get-openapi- │  │
│  │ search       │ repo-content │ content      │ spec         │  │
│  └──────────────┴──────────────┴──────────────┴──────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                            │
                    ┌───────▼───────┐
                    │   Tool        │
                    │  Handler      │
                    │  Layer        │
                    └───────┬───────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│              Intelligence & Processing Layer                     │
│  ┌──────────────────────┐  ┌─────────────────────────────────┐ │
│  │ Progressive Search   │  │ Semantic Cache                  │ │
│  │ Engine               │  │                                 │ │
│  │ - Query Expansion    │  │ - Similarity Matching           │ │
│  │ - Intent Detection   │  │ - TTL Management                │ │
│  │ - Multi-Stage        │  │ - LRU Eviction                  │ │
│  └──────────────────────┘  └─────────────────────────────────┘ │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│               Search & Extraction Layer                         │
│  ┌──────────────────────┐  ┌─────────────────────────────────┐ │
│  │ Search Engine        │  │ Content Extractor               │ │
│  │                      │  │                                 │ │
│  │ - Bing (Chromium)    │  │ - Web Page Extraction           │ │
│  │ - Brave (Firefox)    │  │ - PDF Extraction                │ │
│  │ - DuckDuckGo (axios) │  │ - Quality Validation            │ │
│  │ - Parallel Attempts  │  │ - HTTP/2 Fallback               │ │
│  └──────────────────────┘  └─────────────────────────────────┘ │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│              Infrastructure Layer                               │
│  ┌──────────────────────┐  ┌─────────────────────────────────┐ │
│  │ Browser Pool         │  │ Context Pool                    │ │
│  │                      │  │                                 │ │
│  │ - Reusable contexts  │  │ - Fast browser context reuse    │ │
│  │ - Concurrency        │  │ - Stale context detection       │ │
│  │ - Cleanup            │  │ - Memory management             │ │
│  └──────────────────────┘  └─────────────────────────────────┘ │
│  ┌──────────────────────┐  ┌─────────────────────────────────┐ │
│  │ Enterprise Guardrails│  │ Observability                   │ │
│  │                      │  │                                 │ │
│  │ - Rate Limiting      │  │ - Audit Logging                 │ │
│  │ - Input Validation   │  │ - Telemetry Collection          │ │
│  │ - Output Limiting    │  │ - Structured JSON Logs          │ │
│  └──────────────────────┘  └─────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## Component Details

### 1. MCP Protocol Layer

The entry point for all requests, implementing the Model Context Protocol.

**Key Files**: `src/index.ts`

**Responsibilities**:
- Receive MCP tool calls from clients
- Validate and transform input parameters
- Format responses according to MCP spec
- Handle errors with proper JSON-RPC codes

### 2. Intelligence Layer

Provides smart search capabilities beyond basic keyword matching.

**Key Files**: 
- `src/progressive-search-engine.ts`
- `src/query-intent-detector.ts`
- `src/semantic-expander.ts`
- `src/semantic-cache.ts`

**Responsibilities**:
- Query expansion and rephrasing
- User intent detection
- Semantic caching for repeated queries

### 3. Search Layer

Core web search functionality with multi-engine support.

**Key Files**: 
- `src/search-engine.ts`
- `src/browser-engine.ts`
- `src/enhanced-content-extractor.ts`

**Responsibilities**:
- Parallel search engine attempts (Bing, Brave, DuckDuckGo)
- Content extraction from search results
- Quality validation of extracted content

### 4. Infrastructure Layer

Support services for reliability and security.

**Key Files**: 
- `src/browser-pool.ts`
- `src/context-pool.ts`
- `src/enterprise-guardrails.ts`
- `src/observability.ts`

**Responsibilities**:
- Browser context management
- Rate limiting and input validation
- Logging and telemetry

---

## Data Flow: full-web-search Tool

```
Client Request → MCP Handler → Input Validation → 
    → Search Engine (Parallel Bing/Brave/DDG) → 
    → Content Extraction → Quality Validation → 
    → Result Formatting → Client Response
```

### Step-by-Step Process

1. **Request Received**: MCP server receives tool call with query and parameters
2. **Validation**: Parameters are validated against Zod schemas
3. **Parallel Search**: Three search engines searched simultaneously via `Promise.race()`
4. **Context Reuse**: Browser contexts from pool (~50ms) vs fresh launch (~500ms)
5. **Content Extraction**: Each result URL is fetched and content extracted
6. **Quality Scoring**: Content validated for minimum length (200 chars) and relevance
7. **HTTP/2 Fallback**: Automatic fallback to HTTP/1.1 on protocol errors
8. **Response Format**: Results formatted as structured text response

---

## Component Relationships

```
┌────────────────────────────────────────────────────────────┐
│                    WebSearchMCPServer                      │
│  (src/index.ts - Main entry point)                         │
└─────────────────┬──────────────────────────────────────────┘
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

## Performance Characteristics

| Operation | Typical Time | Notes |
|-----------|-------------|-------|
| Browser launch (fresh) | ~500ms | Not used in production due to pool |
| Context reuse | ~10-50ms | From browser context pool |
| Search request | ~3-4s | Parallel engine attempts |
| Content extraction | ~2-6s per URL | Depends on page complexity |
| PDF extraction (HTTP) | ~1-3s | Fast direct download |
| PDF extraction (browser) | ~5-10s | Fallback for complex PDFs |

---

## Error Handling Strategy

### Error Taxonomy

| Code | Type | Description |
|------|------|-------------|
| -32700 | ParseError | Invalid JSON received |
| -32600 | InvalidRequest | Invalid request object |
| -32602 | InvalidParams | Invalid method parameters |
| -32603 | InternalError | Internal server error |
| -32001 | RequestTimeout | Request timeout |
| -32009 | RateLimitExceeded | Rate limit exceeded |

### Recovery Mechanisms

1. **HTTP/2 to HTTP/1.1 Fallback**: Automatic when protocol errors occur
2. **Context Reuse**: Reduces failure from browser launch issues
3. **Timeout Protection**: Individual operation timeouts prevent hanging
4. **Graceful Degradation**: Partial failures don't stop entire search

---

## Configuration Sources

| Layer | Priority | Description |
|-------|----------|-------------|
| Environment Variables | High | Runtime configuration via `.env` |
| Default Values | Low | Hardcoded sensible defaults |
| Client Overrides | Medium | Per-request parameters |

See `docs/reference/environment-variables.md` for complete list.
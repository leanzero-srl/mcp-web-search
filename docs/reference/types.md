# TypeScript Type Definitions

Reference for all TypeScript types used in the Web Search MCP Server.

---

## Overview

This document provides a complete reference of TypeScript type definitions across the project. All types are defined in `src/types.ts` unless otherwise specified.

---

## Common Types

### SearchResult

Represents a single search result from any search engine.

```typescript
interface SearchResult {
  title: string;           // Page title
  url: string;             // Full URL
  description: string;     // Meta description or snippet
  fullContent: string;     // Extracted page content
  contentPreview: string;  // Short preview of content
  wordCount: number;       // Number of words in content
  timestamp: string;       // ISO format timestamp
  fetchStatus: 'success' | 'error' | 'timeout';
  error?: string;          // Error message if fetch failed
}
```

**Usage**: Returned from search engine operations

### SearchOptions

Options for configuring a search request.

```typescript
interface SearchOptions {
  query: string;       // Search query (required)
  numResults?: number; // Number of results to return
  timeout?: number;    // Request timeout in ms
}
```

**Usage**: Passed to `SearchEngine.search()`

### ContentExtractionOptions

Options for content extraction from a URL.

```typescript
interface ContentExtractionOptions {
  url: string;
  timeout?: number;
  maxContentLength?: number;
}
```

**Usage**: Passed to `EnhancedContentExtractor.extractContent()`

---

## Tool Input/Output Types

### WebSearchToolInput

Input parameters for web search tools.

```typescript
interface WebSearchToolInput {
  query: string;           // Search query (required)
  limit?: number;          // Number of results
  includeContent?: boolean;
  maxContentLength?: number;
}
```

**Usage**: Tool handler receives this as input

### WebSearchToolOutput

Output structure for web search results.

```typescript
interface WebSearchToolOutput {
  results: SearchResult[];
  total_results: number;
  search_time_ms: number;
  query: string;
  status?: string;
}
```

**Usage**: Returned from `handleWebSearch()`

---

## Search Engine Types

### SearchResultWithMetadata

Search result with information about which engine returned it.

```typescript
interface SearchResultWithMetadata {
  results: SearchResult[];
  engine: string;  // 'bing', 'brave', or 'duckduckgo'
}
```

**Usage**: Internal representation of engine responses

---

## GitHub Extractor Types

### GitHubFile

Represents a file in a GitHub repository.

```typescript
interface GitHubFile {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  content?: string;
  encoding?: string;
  url?: string;
}
```

**Usage**: Returned from `GitHubExtractor.extractGitHubContent()`

### GitHubCrawlOptions

Configuration for GitHub repository crawling.

```typescript
interface GitHubCrawlOptions {
  maxDepth?: number;      // Maximum directory depth
  maxFiles?: number;      // Maximum files to extract
  includeCodeOnly?: boolean;
  timeout?: number;
}
```

**Usage**: Passed to `GitHubExtractor.extractGitHubContent()`

---

## PDF Extractor Types

### PdfExtractionResult

Result from PDF content extraction.

```typescript
interface PdfExtractionResult {
  text: string;           // Extracted text content
  extractionMethod: 'http' | 'browser';
  pageCount?: number;
  fileSize?: number;
}
```

**Usage**: Returned from `PdfExtractor.extractPdfContent()`

---

## OpenAPI Extractor Types

### TechnicalDocType

Enum for technical document types.

```typescript
enum TechnicalDocType {
  OPENAPI_JSON = 'openapi-json',
  OPENAPI_YAML = 'openapi-yaml',
  SWAGGER_JSON = 'swagger-json',
  SWAGGER_YAML = 'swagger-yaml',
  API_DOCS = 'api-docs',
  REST_API = 'rest-api',
  TECHNICAL_MD = 'technical-md',
  TECHNICAL_PDF = 'technical-pdf',
}
```

### OpenAPISpecInfo

Metadata about an OpenAPI specification.

```typescript
interface OpenAPISpecInfo {
  url: string;
  title?: string;
  version?: string;
  description?: string;
  basePath?: string;
  docType: TechnicalDocType;
  size?: number;
  timestamp: string;
}
```

### DownloadedOpenAPI

Information about a downloaded OpenAPI specification.

```typescript
interface DownloadedOpenAPI {
  id: string;
  originalUrl: string;
  localPath: string;
  fileName: string;
  openAPISpec: OpenAPISpecInfo;
  downloadTime: string;
  domain: string;
  path: string;
  keywords?: string[];
}
```

### OpenAPIExtractionResult

Result from OpenAPI specification extraction.

```typescript
interface OpenAPIExtractionResult {
  success: boolean;
  url: string;
  openAPISpec?: OpenAPISpecInfo;
  downloadedFile?: DownloadedOpenAPI;
  error?: string;
  detectedType?: TechnicalDocType;
}
```

### OpenAPIExtractionOptions

Options for OpenAPI extraction.

```typescript
interface OpenAPIExtractionOptions {
  url?: string;
  downloadDir?: string;
  maxContentLength?: number;
  timeout?: number;
  forceRefresh?: boolean;
}
```

---

## Caching Types

### CrawlCacheEntry

Represents a cached crawl result.

```typescript
interface CrawlCacheEntry {
  url: string;
  timestamp: string;
  expiresAt: string;
  contentHash: string;
  docType?: TechnicalDocType;
  title?: string;
  metadata?: Record<string, unknown>;
}
```

**Usage**: Internal cache management

---

## Progressive Search Types

### ProgressiveSearchOptions

Configuration for progressive search.

```typescript
interface ProgressiveSearchOptions {
  query: string;           // Original query (required)
  maxDepth?: number;       // Maximum expansion stages
  minResultsPerStage?: number;
  maxTotalResults?: number;
}
```

### ProgressiveSearchResult

A search result with progressive search metadata.

```typescript
interface ProgressiveSearchResult extends SearchResult {
  stage: number;          // Which stage this came from
  queryUsed: string;      // Query used to find this result
  relevanceScore: number; // 0-1 relevance score
}
```

---

## Enterprise Guardrails Types

### SessionState

Represents the state of a client session for rate limiting.

```typescript
interface SessionState {
  sessionId: string;
  requestId: string;
  requestCount: number;
  lastRequestTime: number;
  blocked: boolean;
}
```

**Usage**: Internal to `SessionRateLimiter`

### RateLimitResult

Result of a rate limit check.

```typescript
interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}
```

---

## Module-Specific Types

### BrowserPool Types

#### BrowserContextInfo

Information about a browser context in the pool.

```typescript
interface BrowserContextInfo {
  id: string;
  context: BrowserContext;  // Playwright type
  lastUsed: number;
  usageCount: number;
}
```

---

## Utility Types

### RequestStatus

Generic request status enum.

```typescript
enum RequestStatus {
  Pending = 'pending',
  Success = 'success',
  Failed = 'failed',
  Timeout = 'timeout',
}
```

**Usage**: Tracking request lifecycle

### DocumentSource

Where document content came from.

```typescript
type DocumentSource = 
  | 'http'
  | 'browser'
  | 'cached'
  | 'api';
```

**Usage**: Logging and telemetry

---

## Type Conversion Helpers

The project includes utility functions for type conversion:

### parseNumber

Safely converts string to number.

```typescript
function parseNumber(value: string | number, defaultValue?: number): number {
  const num = typeof value === 'string' ? parseInt(value, 10) : value;
  return isNaN(num) && defaultValue !== undefined ? defaultValue : num;
}
```

**Usage**: `src/utils.ts`

---

## Error Types

### McpError

Custom error class for MCP protocol errors.

```typescript
class McpError extends Error {
  readonly code: number;  // JSON-RPC error code
  
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = 'McpError';
  }
}
```

**Usage**: `src/index.ts` - All tool errors use this class

### Error Codes

| Code | Name | Description |
|------|------|-------------|
| -32700 | ParseError | Invalid JSON received |
| -32600 | InvalidRequest | Invalid request object |
| -32602 | InvalidParams | Invalid method parameters |
| -32603 | InternalError | Internal server error |
| -32001 | RequestTimeout | Request timeout |
| -32009 | RateLimitExceeded | Rate limit exceeded |

---

## Complete Type Import Reference

```typescript
// All types can be imported from:
import {
  SearchResult,
  SearchOptions,
  ContentExtractionOptions,
  WebSearchToolInput,
  WebSearchToolOutput,
  SearchResultWithMetadata,
  GitHubFile,
  GitHubCrawlOptions,
  PdfExtractionResult,
  TechnicalDocType,
  OpenAPISpecInfo,
  DownloadedOpenAPI,
  CrawlCacheEntry,
  ProgressiveSearchOptions,
  ProgressiveSearchResult,
} from './types.js';
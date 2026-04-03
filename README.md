# Web Search MCP Server for use with Local LLMs

A TypeScript MCP (Model Context Protocol) server that provides comprehensive web search capabilities using direct connections (no API keys required) with multiple tools for different use cases.

This is a fork of the original [web-search-mcp](https://github.com/mrkrsl/web-search-mcp) project, significantly enhanced to address critical performance issues and reliability problems.

## Performance Improvements

This fork addresses two major issues with the original implementation:

### 1. Single Page Content Extraction Timeouts
The original `get-single-web-page-content` tool frequently timed out with an 8-second timeout that was too aggressive for complex pages. This fork resolves this by:
- Implementing content quality scoring to validate results before returning
- Adding HTTP/2 protocol error recovery with automatic fallback to HTTP/1.1
- Improving browser context management and reuse

### 2. Slow Performance (10+ seconds)
The original implementation was slow due to sequential search engine attempts and browser launch overhead. This fork implements:
- **Parallel search attempts**: Multiple engines searched simultaneously using `Promise.race()`
- **Context pooling**: Browser contexts are reused (~10-50ms) instead of launching fresh browsers (~500ms)
- **WebKit-first optimization**: WebKit is the fastest engine for web search tasks

**Expected Performance Improvements:**
- Search time: Reduced from 10s+ to ~3-4s (60-70% faster)
- Context reuse: ~50x faster than fresh browser launches
- Single page tool reliability: Significantly improved with quality validation

## Observability & Production Readiness (New)

This fork now includes comprehensive observability and production-ready features:

### 1. Structured Audit Logging
All tool calls, successes, failures, and errors are logged in structured JSON format for:
- Full audit trail of all API interactions
- Debugging and troubleshooting with complete context
- Sensitive data redaction (API keys, tokens, passwords)

**Log Format:**
```json
{
  "timestamp": "2025-04-03T10:00:00.000Z",
  "level": "info|error",
  "event": "tool_call|tool_success|tool_error",
  "tool": "full-web-search",
  "query": "search query",
  "duration_ms": 1250,
  "num_results_returned": 5,
  "content_length": 45230
}
```

### 2. Telemetry & Metrics Collection
Real-time metrics tracking for monitoring and alerting:
- Tool call success/failure rates
- Search engine performance (latency, success rate per engine)
- Average content extraction times

**Example Metrics:**
```
=== MCP Web Search Telemetry Summary ===
Total Tool Calls: 150
Successful: 142 (94%)
Failed: 8
Average Search Time: 3.2s

Search Engine Stats:
  bing: 65 calls (97% success)
  brave: 50 calls (92% success)
  duckduckgo: 35 calls (86% success)
```

### 3. Enhanced Error Handling
Comprehensive error taxonomy with proper JSON-RPC 2.0 codes:
- **ParseError** (-32700): Invalid JSON received
- **InvalidRequest** (-32600): Invalid request object
- **InvalidParams** (-32602): Invalid method parameters
- **InternalError** (-32603): Internal server error
- **ResourceNotFound** (-32002): Resource not found (MCP spec)
- **RequestTimeout** (-32001): Request timeout
- **RateLimitExceeded** (-32009): Rate limit exceeded

### 4. Production Features
- Automatic browser cleanup after each operation
- Graceful shutdown handling for SIGINT/SIGTERM
- Memory leak prevention with context pooling
- HTTP/2 to HTTP/1.1 fallback for protocol errors

## Enterprise Guardrails (New)

This fork now includes comprehensive security and enterprise-ready features:

### 1. Per-Session Rate Limiting
Track and limit requests per client session/user:
- Configurable limits per session (default: 30 requests/minute)
- Automatic reset after configurable time window
- Session state tracking with blocking on exceeded limits

**Environment Variables:**
- `MAX_REQUESTS_PER_MINUTE`: Maximum requests per minute per session (default: 30)

### 2. Input Validation & Sanitization
Validate all tool arguments before processing:
- Query length validation (max 1000 characters default)
- URL format validation
- Parameter type checking and coercion
- Allowed argument whitelist per tool

**Validated Fields:**
- `query`: Must be non-empty string, max length
- `limit`: Must be number/string between 1-20
- `includeContent`: Boolean or boolean-like strings
- `url`: Must start with http:// or https://

### 3. Output Length Limiting
Prevent token overflow by limiting output size:
- Configurable maximum content length (default: 50000 characters)
- Automatic truncation with clear indicators
- Graceful degradation for large responses

**Environment Variables:**
- `MAX_OUTPUT_LENGTH`: Maximum output content length in characters (default: 50000)

### 4. Global Request Throttling
Prevent server overload from too many concurrent requests:
- Configurable max requests per second (default: 10)
- Automatic rejection when limit exceeded
- Queue-based processing to smooth traffic spikes

**Environment Variables:**
- `MAX_REQUESTS_PER_SECOND`: Maximum global requests per second (default: 10)

### 5. Session Management
Manage client sessions efficiently:
- Session state tracking with automatic cleanup
- Session count monitoring for debugging
- Clear all sessions for testing/reset scenarios

## Intelligence Expansion (New - Phase 3)

This fork now includes advanced intelligence features:

### 1. PDF Extractor Module (`src/pdf-extractor.ts`)
High-fidelity PDF content extraction using multiple strategies:
- **HTTP-based extraction**: Direct download with text extraction (fast)
- **Browser-based rendering**: Fallback for complex PDFs
- **Multiple fallback mechanisms**: Ensures reliability even for problematic sources

**Features:**
- Extracts text from PDF files with quality validation
- Automatic fallback between HTTP and browser methods
- Configurable timeout and content length limits
- Integration with existing audit logging and telemetry

**Usage Example:**
```typescript
import { pdfExtractor } from './pdf-extractor.js';

const result = await pdfExtractor.extractPdfContent('https://example.com/document.pdf');
console.log(result.text);
```

### 2. Semantic Cache Layer (`src/semantic-cache.ts`)
Intelligent caching with semantic similarity matching:
- **Query meaning matching**: Cache results by query semantic meaning, not just exact match
- **Automatic cache invalidation**: Based on freshness requirements (configurable TTL)
- **Memory-efficient storage**: Configurable limits with automatic eviction of oldest entries

**Features:**
- Fuzzy term matching for similar queries (~70% overlap threshold)
- Automatic TTL-based expiration (default: 1 hour)
- LRU-style eviction when cache is full
- Audit logging for cache hits/misses

**Environment Variables:**
- `SEMANTIC_CACHE_MAX_SIZE`: Maximum number of cached entries (default: 1000)
- `SEMANTIC_CACHE_TTL`: Cache TTL in milliseconds (default: 3600000 = 1 hour)

### 3. Enhanced Tool Integration
All Phase 3 modules are fully integrated with:
- Existing audit logging system
- Telemetry collection for performance monitoring
- Enterprise guardrails (rate limiting, input validation)
- Graceful error handling and recovery

## Features

### Web Search Features
- **Multi-Engine Web Search**: Parallel attempts prioritizing Bing > Brave > DuckDuckGo for optimal reliability and performance
- **Full Page Content Extraction**: Fetches and extracts complete page content from search results with automatic fallback mechanisms
- **Multiple Search Tools**: Three specialised tools for different use cases
- **Smart Request Strategy**: Uses axios for fast requests, falls back to Playwright browsers when needed
- **Concurrent Processing**: Extracts content from multiple pages simultaneously
- **Content Quality Validation**: Ensures minimum 200 characters and relevance scoring before returning results

### GitHub Repository Crawler
- **README.md Extraction**: Directly fetches README content using GitHub API
- **Code File Crawling**: Recursively crawls repository structure to find code files (.js, .ts, .py, etc.)
- **Content Preview**: Extracts first 500 characters of each file for quick inspection
- **Configurable Limits**: Control depth and number of files extracted via environment variables

## How It Works

The server provides three specialised tools for different web search needs:

### 1. `full-web-search` (Main Tool)
When a comprehensive search is requested, the server uses an **optimised parallel strategy**:
1. **Parallel multi-engine search**: Bing (Chromium), Brave (Firefox), and DuckDuckGo (axios) are attempted simultaneously using `Promise.race()`
2. **Context pooling**: Browser contexts are reused from a pool (~10-50ms reuse vs ~500ms fresh launch)
3. **Content extraction priority**: Tries axios first for speed, then Playwright browser with human behavior simulation
4. **Concurrent processing**: Extracts content from multiple pages simultaneously with timeout protection
5. **HTTP/2 error recovery**: Automatically falls back to HTTP/1.1 when protocol errors occur
6. **Quality validation**: Content is validated before returning (minimum 200 characters)

### 2. `get-web-search-summaries` (Lightweight Alternative)
For quick search results without full content extraction:
1. Performs the same parallel multi-engine search as `full-web-search`
2. Returns only the search result snippets/descriptions
3. Does not follow links to extract full page content
4. Significantly faster than `full-web-search` when content is not needed

### 3. `get-single-web-page-content` (Utility Tool)
For extracting content from a specific webpage:
1. Takes a single URL as input
2. Follows the URL and extracts the main page content using Playwright browser
3. Removes navigation, ads, and other non-content elements
4. Validates content quality before returning results
5. Includes HTTP/2 to HTTP/1.1 fallback for reliability

## Browser Engine Optimization

This fork implements advanced browser engine selection:

### WebKit (Default)
- **Fastest engine** for web search tasks due to smaller footprint
- Uses Playwright's native WebKit support
- Ideal for headless server environments

### Chromium with New Headless Mode
- Alternative when WebKit is unavailable
- Uses `channel: 'chromium'` option for better performance than legacy headless
- Full Chrome compatibility when needed

### Firefox Fallback
- Available as backup engine type
- Used only if primary engines fail

## Installation (Recommended)

**Requirements:**
- Node.js 18.0.0 or higher
- npm 8.0.0 or higher

1. Download the latest release zip file from the [Releases page](https://github.com/mrkrsl/web-search-mcp/releases)
2. Extract the zip file to a location on your system (e.g., `~/mcp-servers/web-search-mcp/`)
3. **Open a terminal in the extracted folder and run:**
   ```bash
   npm install
   npx playwright install
   npm run build
   ```
   This will create a `node_modules` folder with all required dependencies, install Playwright browsers, and build the project.

   **Note:** You must run `npm install` in the root of the extracted folder (not in `dist/`).
4. Configure your `mcp.json` to point to the extracted `dist/index.js` file:

```json
{
  "mcpServers": {
    "web-search": {
      "command": "node",
      "args": ["/path/to/extracted/web-search-mcp/dist/index.js"]
    }
  }
}
```
**Example paths:**
- macOS/Linux: `~/mcp-servers/web-search-mcp/dist/index.js`
- Windows: `C:\\mcp-servers\\web-search-mcp\\dist\\index.js`

In LibreChat, you can include the MCP server in the librechat.yaml. If you are running LibreChat in Docker, you must first mount your local directory in docker-compose.override.yml.

in `docker-compose.override.yml`:
```yaml
services:
  api:
    volumes:
    - type: bind
      source: /path/to/your/mcp/directory
      target: /app/mcp
```
in `librechat.yaml`:
```yaml
mcpServers:
  web-search:
    type: stdio
    command: node
    args:
    - /app/mcp/web-search-mcp/dist/index.js
    serverInstructions: true
```

**Troubleshooting:**
- If `npm install` fails, try updating Node.js to version 18+ and npm to version 8+
- If `npm run build` fails, ensure you have the latest Node.js version installed
- For older Node.js versions, you may need to use an older release of this project

## Environment Variables

The server supports several environment variables for configuration:

### Basic Configuration
- **`MAX_CONTENT_LENGTH`**: Maximum content length in characters (default: 500000)
- **`DEFAULT_TIMEOUT`**: Default timeout for requests in milliseconds (default: 6000)
- **`MIN_CONTENT_LENGTH`**: Minimum content length required for valid results (default: 200)

### Browser Configuration
- **`MAX_BROWSERS`**: Maximum number of browser instances to maintain (default: 3)
- **`BROWSER_TYPES`**: Comma-separated list of browser types to use (default: 'webkit,chromium,firefox', options: webkit, chromium, firefox)
- **`BROWSER_HEADLESS`**: Enable headless mode for browsers (default: true)

### Context Pool Configuration
- **`CONTEXT_POOL_SIZE`**: Maximum number of contexts in the pool (default: 10)
- **`CONTEXT_REUSE_TIMEOUT`**: Time in milliseconds before context is considered stale (default: 30000)
- **`CONTEXT_MAX_AGE`**: Maximum age of context in milliseconds before forced refresh (default: 60000)

### Search Quality and Engine Selection
- **`ENABLE_RELEVANCE_CHECKING`**: Enable/disable search result quality validation (default: true)
- **`RELEVANCE_THRESHOLD`**: Minimum quality score for search results (0.0-1.0, default: 0.3)
- **`FORCE_MULTI_ENGINE_SEARCH`**: Try all search engines and return best results (default: false)

### Performance Tuning
- **`BROWSER_FALLBACK_THRESHOLD`**: Number of axios failures before using browser fallback (default: 3)
- **`DEBUG_BROWSER_LIFECYCLE`**: Enable detailed browser lifecycle logging for debugging (default: false)

### Observability Configuration
- **`DEBUG_AUDIT`**: Enable structured audit logging to stderr (set to `true` to enable). When enabled, all tool calls and errors are logged in JSON format to stderr for debugging and monitoring.

### Enterprise Guardrails Configuration
- **`MAX_REQUESTS_PER_MINUTE`**: Maximum requests per minute per session (default: 30)
- **`MAX_OUTPUT_LENGTH`**: Maximum output content length in characters (default: 50000)
- **`MAX_REQUESTS_PER_SECOND`**: Maximum global requests per second (default: 10)

### Intelligence Expansion Configuration
- **`SEMANTIC_CACHE_MAX_SIZE`**: Maximum number of cached entries (default: 1000)
- **`SEMANTIC_CACHE_TTL`**: Cache TTL in milliseconds (default: 3600000 = 1 hour)

## Performance Optimisations

This fork includes several performance optimisations not present in the original:

### Context Pooling
Instead of launching a new browser (~500ms) for each search engine attempt, contexts are reused from a pool:
- Reuse timeout: 30 seconds (configurable via `CONTEXT_REUSE_TIMEOUT`)
- Max age: 60 seconds (configurable via `CONTEXT_MAX_AGE`)
- Pool size: 10 contexts (configurable via `CONTEXT_POOL_SIZE`)

### Parallel Search Attempts
All three search engines are attempted simultaneously:
- Bing (Chromium/WebKit)
- Brave (Firefox)
- DuckDuckGo (axios)

The first successful response is returned immediately, avoiding sequential waiting.

### Quality Scoring
Content is scored and validated before returning:
- Minimum 200 characters required for valid results
- Relevance scoring based on query keywords
- Automatic fallback to browser extraction if axios returns low-quality content

## Troubleshooting

### Slow Response Times
The server has been optimised for speed, but you can further tune performance:

**Reduce timeouts:**
Set `DEFAULT_TIMEOUT=4000` for even faster responses (may reduce success rate on slow sites)

**Use fewer browsers:**
Set `MAX_BROWSERS=1` to reduce memory usage

**Limit context pool size:**
Set `CONTEXT_POOL_SIZE=5` to reduce memory usage at the cost of some reuse benefits

### Search Failures
- **Check browser installation**: Run `npx playwright install` to ensure browsers are available
- **Try headless mode**: Ensure `BROWSER_HEADLESS=true` (default) for server environments
- **Network restrictions**: Some networks block browser automation - try different network or VPN
- **HTTP/2 issues**: The server automatically handles HTTP/2 protocol errors with fallback to HTTP/1.1

### Search Quality Issues
- **Enable quality checking**: Set `ENABLE_RELEVANCE_CHECKING=true` (enabled by default)
- **Adjust quality threshold**: Set `RELEVANCE_THRESHOLD=0.5` for stricter quality requirements
- **Force multi-engine search**: Set `FORCE_MULTI_ENGINE_SEARCH=true` to try all engines and return the best results

### Single Page Tool Timeouts
If the single page tool still times out:
- Increase timeout: Set `DEFAULT_TIMEOUT=10000` (10 seconds)
- Enable browser fallback: Set `BROWSER_FALLBACK_THRESHOLD=2`
- Use parallel engine search: Set `FORCE_MULTI_ENGINE_SEARCH=true`

### Memory Usage
- **Automatic cleanup**: Browsers and contexts are automatically cleaned up after each operation
- **Limit browsers**: Reduce `MAX_BROWSERS` (default: 3)
- **Reduce context pool**: Lower `CONTEXT_POOL_SIZE` to limit memory usage

## GitHub Repository Crawler

The server also provides a tool for extracting content from GitHub repositories:

### 4. `get-github-repo-content`
A specialized tool for crawling GitHub repositories:
1. Takes a GitHub repository URL as input
2. Fetches the README.md file directly using GitHub API
3. Recursively crawls the repository structure to find code files
4. Extracts content previews from each file (.js, .ts, .py, etc.)
5. Returns structured information about the repository

**Example Usage:**
```json
{
  "name": "get-github-repo-content",
  "arguments": {
    "url": "https://github.com/owner/repo",
    "maxDepth": 3,
    "maxFiles": 50
  }
}
```

**Parameters:**
- `url`: The URL of the GitHub repository (required)
- `maxDepth`: Maximum directory depth to crawl (optional, default: from environment or 3)
- `maxFiles`: Maximum number of files to extract content from (optional, default: from environment or 50)

### Environment Variables

The server supports several environment variables for configuration:

#### Basic Configuration
- **`MAX_CONTENT_LENGTH`**: Maximum content length in characters (default: 500000)
- **`DEFAULT_TIMEOUT`**: Default timeout for requests in milliseconds (default: 6000)
- **`MIN_CONTENT_LENGTH`**: Minimum content length required for valid results (default: 200)

#### Browser Configuration
- **`MAX_BROWSERS`**: Maximum number of browser instances to maintain (default: 3)
- **`BROWSER_TYPES`**: Comma-separated list of browser types to use (default: 'webkit,chromium,firefox', options: webkit, chromium, firefox)
- **`BROWSER_HEADLESS`**: Enable headless mode for browsers (default: true)

#### Context Pool Configuration
- **`CONTEXT_POOL_SIZE`**: Maximum number of contexts in the pool (default: 10)
- **`CONTEXT_REUSE_TIMEOUT`**: Time in milliseconds before context is considered stale (default: 30000)
- **`CONTEXT_MAX_AGE`**: Maximum age of context in milliseconds before forced refresh (default: 60000)

#### Search Quality and Engine Selection
- **`ENABLE_RELEVANCE_CHECKING`**: Enable/disable search result quality validation (default: true)
- **`RELEVANCE_THRESHOLD`**: Minimum quality score for search results (0.0-1.0, default: 0.3)
- **`FORCE_MULTI_ENGINE_SEARCH`**: Try all search engines and return best results (default: false)

#### Performance Tuning
- **`BROWSER_FALLBACK_THRESHOLD`**: Number of axios failures before using browser fallback (default: 3)
- **`DEBUG_BROWSER_LIFECYCLE`**: Enable detailed browser lifecycle logging for debugging (default: false)

#### GitHub Repository Crawler Configuration
- **`GITHUB_MAX_DEPTH`**: Maximum directory depth to crawl (default: 3)
- **`GITHUB_MAX_FILES`**: Maximum number of files to extract content from (default: 50)
- **`GITHUB_TIMEOUT`**: Request timeout in milliseconds (default: 10000)

#### Code File Extensions
The crawler automatically identifies and extracts content from common code file extensions:
```
.js, .ts, .jsx, .tsx, .py, .java, .go, .rs, .rb,
.php, .cs, .cpp, .c, .h, .hpp, .swift, .kt, .scala,
.sh, .bash, .yml, .yaml, .json, .xml, .html, .css,
.scss, .sass, .less, .sql, .md, .rst, .txt
```

## Compatibility

This MCP server has been developed and tested with **LM Studio** and **LibreChat**. It has not been tested with other MCP clients.

### Model Compatibility
**Important:** Prioritise using more recent models designated for tool use. 

Older models (even those with tool use specified) may not work or may work erratically. This seems to be the case with Llama and Deepseek. Qwen3 and Gemma 3 currently have the best results.

- ✅ Works well with: **Qwen3**
- ✅ Works well with: **Gemma 3**
- ✅ Works with: **Llama 3.2**
- ✅ Works with: Recent **Llama 3.1** (e.g 3.1 swallow-8B)
- ✅ Works with: Recent **Deepseek R1** (e.g 0528 works)
- ⚠️ May have issues with: Some versions of **Llama** and **Deepseek R1**
- ❌ May not work with: Older versions of **Llama** and **Deepseek R1**

## For Development

```bash
git clone https://github.com/mrkrsl/web-search-mcp.git
cd web-search-mcp
npm install
npx playwright install
npm run build
```

## Development

```bash
npm run dev    # Development with hot reload
npm run build  # Build TypeScript to JavaScript
npm run lint   # Run ESLint
npm run format # Run Prettier
```

## MCP Tools

This server provides four specialised tools for different web search needs:

### 1. `full-web-search` (Main Tool)
The most comprehensive web search tool that:
1. Takes a search query and optional number of results (1-10, default 5)
2. Performs parallel web search (tries Bing, Brave, DuckDuckGo simultaneously)
3. Fetches full page content from each result URL with concurrent processing
4. Returns structured data with search results and extracted content
5. **Enhanced reliability**: HTTP/2 error recovery, quality validation, and better error handling

**Example Usage:**
```json
{
  "name": "full-web-search",
  "arguments": {
    "query": "TypeScript MCP server",
    "limit": 3,
    "includeContent": true
  }
}
```

### 2. `get-web-search-summaries` (Lightweight Alternative)
A lightweight alternative for quick search results:
1. Takes a search query and optional number of results (1-10, default 5)
2. Performs the same parallel multi-engine search as `full-web-search`
3. Returns only search result snippets/descriptions (no content extraction)
4. Faster and more efficient for quick research

**Example Usage:**
```json
{
  "name": "get-web-search-summaries",
  "arguments": {
    "query": "TypeScript MCP server",
    "limit": 5
  }
}
```

### 3. `get-single-web-page-content` (Utility Tool)
A utility tool for extracting content from a specific webpage:
1. Takes a single URL as input
2. Follows the URL and extracts the main page content using Playwright browser
3. Removes navigation, ads, and other non-content elements
4. Validates content quality before returning results
5. Useful for getting detailed content from a known webpage

**Example Usage:**
```json
{
  "name": "get-single-web-page-content",
  "arguments": {
    "url": "https://example.com/article",
    "maxContentLength": 5000
  }
}
```

### 4. `get-github-repo-content` (Repository Crawler)
A specialized tool for extracting content from GitHub repositories:
1. Takes a GitHub repository URL as input
2. Fetches the README.md file directly using GitHub API
3. Recursively crawls the repository structure to find code files (.js, .ts, .py, etc.)
4. Extracts content previews from each file (first 500 characters)
5. Returns structured information about the repository

**Example Usage:**
```json
{
  "name": "get-github-repo-content",
  "arguments": {
    "url": "https://github.com/owner/repo",
    "maxDepth": 3,
    "maxFiles": 50
  }
}
```

**Parameters:**
- `url`: The URL of the GitHub repository (required)
- `maxDepth`: Maximum directory depth to crawl (optional, default: from environment or 3)
- `maxFiles`: Maximum number of files to extract content from (optional, default: from environment or 50)

### 5. `progressive-web-search` (Advanced Strategy with Automatic Expansion)
An advanced search tool that uses intelligent query expansion strategies to find the best results:

**How It Works:**
1. **Stage 1 - Literal Search**: Starts with the exact user query in its original form
2. **Stage 2+ - Semantic Expansion**: If good results aren't found, automatically expands the query using:
   - Synonym replacement (e.g., "tools" → "software applications", "platforms")
   - Phrase variations (e.g., "How to X" → "Guide for X", "Tutorial about X")
   - The semantic enrichment from synonym databases
3. **Stage 3+ - Topic Deepening**: If still not enough results, searches related topics based on key concepts in the query
4. **Relevance Scoring**: Each result is scored and sorted by relevance to ensure best results appear first

**Use Cases:**
- Complex research where the exact wording might not match the best sources
- Exploratory searches where you're not sure of the exact terminology
- Finding resources when technical terms have evolved or vary by region
- Multi-faceted queries that benefit from different phrasings

**Example Usage:**
```json
{
  "name": "progressive-web-search",
  "arguments": {
    "query": "best coding tools for beginners",
    "maxDepth": 3,
    "limit": 10
  }
}
```

**Parameters:**
- `query`: The search query to execute (required)
- `maxDepth`: Maximum number of expansion stages (1-5, default: 3)
- `limit`: Maximum number of results to return (1-20, default: 10)

**Query Expansion Examples:**
| Original Query | Expanded Variations |
|----------------|---------------------|
| "ai tools" | "artificial intelligence software applications", "machine learning platforms", "best ai tools" |
| "fix code" | "repair code", "resolve code issues", "correct programming errors" |
| "create app" | "build application", "develop software", "make mobile app" |
| "how to learn" | "guide for learning", "tutorial about learning", "learn how to..." |

## Standalone Usage

You can also run the server directly:
```bash
# If running from source
npm start
```

## Documentation

See [API.md](./docs/API.md) for complete technical details.

## License

MIT License - see [LICENSE](./LICENSE) for details.

## Feedback

This is an open source project and we welcome feedback! If you encounter any issues or have suggestions for improvements, please:

- Open an issue on GitHub
- Submit a pull request
### 6. `get-pdf-content` (PDF Extraction)
Extract and return text content from a PDF document:

**Features:**
- HTTP-based extraction for fast, direct downloads
- Browser fallback for complex PDFs that need rendering
- Automatic quality validation before returning results

**Use Cases:**
- Extracting text from research papers (PDF format)
- Reading documentation that's only available as PDF
- Getting content from academic sources and technical reports

**Example Usage:**
```json
{
  "name": "get-pdf-content",
  "arguments": {
    "url": "https://arxiv.org/pdf/2305.12345.pdf",
    "maxContentLength": 5000
  }
}
```

**Parameters:**
- `url`: The URL of the PDF file to extract content from (required)
- `maxContentLength`: Maximum characters for extracted content (optional, default: no limit)

### 7. `cached-web-search` (Intelligent Caching)
Search the web using intelligent semantic caching:

**Features:**
- Checks if similar queries have been recently searched
- Returns cached results when available (saves time and resources)
- Fallback to fresh search with automatic cache population

**Use Cases:**
- Repeated or related queries (cache hit saves API calls)
- Reducing latency for frequently accessed information
- Lowering resource usage during development/testing

**Example Usage:**
```json
{
  "name": "cached-web-search",
  "arguments": {
    "query": "TypeScript MCP server",
    "limit": 5,
    "includeContent": true
  }
}
```

**Parameters:**
- `query`: The search query to execute (required)
- `limit`: Maximum number of results (1-10, default: 5)
- `includeContent`: Whether to fetch full page content (default: true)
- `maxContentLength`: Maximum characters per result (optional)

## Standalone Usage

You can also run the server directly:
```bash
# If running from source
npm start
```

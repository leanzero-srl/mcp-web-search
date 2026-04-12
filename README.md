# Web Search MCP Server

**A high-performance, production-ready web search orchestration system specifically engineered for local AI agents.**

> **Note:** This is a fork of [mrkrsl/web-search-mcp](https://github.com/mrkrsl/web-search-mcp) with significantly enhanced orchestration, enterprise guardrails, and intelligent content extraction capabilities.

---

## 🎯 Who Is This For?

This server is built for **Local AI Users**—individuals running Large Language Models (LLMs) on their own hardware or via private instances.

- ✅ **Cline / Roo Code Users**: Perfect for autonomous coding agents that need to research documentation or libraries.
- ✅ **Claude Desktop Users**: Seamlessly add web browsing capabilities to your local Claude interface.
- ✅ **Privacy-First Researchers**: Perform deep web research without sending your entire prompt history to third-party search APIs.
- ✅ **Agent Developers**: A robust, modular foundation for building complex AI agents with built-in rate limiting and quality control.

---

## 🚀 What It Does (The Technical Edge)

Unlike simple search tools that just return a list of links, this MCP server acts as an **intelligent orchestration layer** between your AI agent and the web.

### 🛠️ The Orchestration Workflow

1.  **Intent Detection**: Analyzes the query to determine if it requires a simple summary or deep content extraction.
2.  **Intelligent Engine Selection**: Automatically routes requests through Bing, Brave, or DuckDuckGo, with automatic failover if one engine is blocked or rate-limited.
3.  **Multi-Stage Extraction**: 
    -   **Stage 1 (Fast)**: Uses high-speed HTTP clients (Axios) for standard pages.
    -   **Stage 2 (Stealth)**: If Stage 1 fails (e.g., due to bot detection), it automatically spins up a headless browser (Playwright) to bypass protections.
4.  **Content Intelligence**:
    -   **Semantic Caching**: Remembers previous searches to provide instant, relevant results for similar queries.
    -   **Quality Scoring**: Evaluates the relevance and "noise" of extracted content before handing it to your AI.
    -   **Markdown Conversion**: Converts messy HTML into clean, structured Markdown optimized for LLM context windows.

---

## ⚙️ Setup & Configuration

### 1. Installation

```bash
# Clone and install dependencies
cd mcp-web-search
npm install
npm run build
```

### 2. Configuring your MCP Client (Crucial)

To use this with your local AI agent, you must add it to your client's configuration file.

#### For Claude Desktop
Edit your `claude_desktop_config.json` (usually in `%APPDATA%\Claude` on Windows or `~/Library/Application Support/Claude` on macOS):

```json
{
  "mcpServers": {
    "web-search": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mcp-web-search/dist/index.js"],
      "env": {
        "SERPER_API_KEY": "your_key_here",
        "SEARCH_ENGINE": "bing",
        "BROWSER_HEADLESS": "true"
      }
    }
  }
}
```

#### For Cline / Roo Code (VS Code)
Add the following to your MCP settings in the extension:

```json
{
  "mcpServers": {
    "web-search": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mcp-web-search/dist/index.js"],
      "env": {
        "SEARCH_ENGINE": "brave",
        "MAX_CONTENT_LENGTH": "100000"
      }
    }
  }
}
```

---

## 🔧 Configuration Deep Dive

You can fine-tune the server's behavior using **Environment Variables**. These are passed via the `env` block in your MCP client configuration.

### 🔍 Search & API Settings
| Variable | Default | Description |
|----------|---------|-------------|
| `SEARCH_ENGINE` | `bing` | `bing`, `brave`, `duckduckgo`, or `serper` |
| `SERPER_API_KEY` | *none* | Required if using `serper` engine |
| `SEARCH_ENGINE_MAX_RPM` | `50` | Max requests per minute to the search engine (increased from 10) |
| `SEARCH_ENGINE_RESET_MS` | `60000` | Reset window for RPM in milliseconds |
| `DEBUG_BING_SEARCH` | `false` | Set to `true` for verbose Bing parsing logs |
| `USE_SERPER_ONLY` | `false` | **Performance**: Skip browser engines when Serper API succeeds |
| `PARALLEL_SEARCH` | `true` | Enable parallel engine searches (disable for faster single-engine) |

### 📄 Content Extraction & Quality
| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_CONTENT_LENGTH` | `500000` | Max bytes per page (prevents context overflow) |
| `MIN_CONTENT_LENGTH` | `200` | Minimum bytes required for a valid result |
| `DEFAULT_TIMEOUT` | `6000` | Timeout for extraction in ms |
| `BROWSER_FALLBACK_THRESHOLD`| `3` | Failures before switching to headless browser |
| `ENABLE_RELEVANCE_CHECKING` | `true` | Enables AI-ready quality scoring |
| `RELEVANCE_THRESHOLD` | `0.3` | Minimum score (0.0-1.0) for valid content |

### 🌐 Browser & Stealth Management
| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSER_HEADLESS` | `true` | Set to `false` to see the browser in action |
| `BROWSER_TYPES` | `chromium,firefox`| Comma-separated list of browsers to use |
| `MAX_BROWSERS` | `3` | Max concurrent browser instances |
| `CONTEXT_POOL_SIZE` | `10` | Max browser contexts kept in memory |
| `CONTEXT_MAX_AGE` | `60000` | How long a context stays alive (ms) |
| `CONTEXT_REUSE_TIMEOUT` | `20000` | Time before context reuse attempt (default: 20s) |
| `USE_LEGACY_POOL` | `false` | Use the older, more stable pool implementation |

### 🛡️ Enterprise Guardrails
| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_REQUESTS_PER_MINUTE` | `30` | Global session rate limit |
| `MAX_REQUESTS_PER_SECOND` | `10` | Global server throttle (prevents CPU spikes) |
| `MAX_OUTPUT_LENGTH` | `50000` | Max characters returned in a single tool response |

### 📂 GitHub & Repository Extraction
| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` | *none* | Personal Access Token for deeper repo access |
| `GITHUB_MAX_DEPTH` | `3` | Max directory depth to crawl |
| `GITHUB_MAX_FILES` | `50` | Max files to extract per repository |

### ⚡ Performance Optimizations
| Variable | Default | Description |
|----------|---------|-------------|
| `SEMANTIC_CACHE_ENABLED` | `true` | Enable caching for repeated/similar queries |
| `SEMANTIC_CACHE_MAX_SIZE` | `1000` | Max cached search results |
| `SEMANTIC_CACHE_TTL` | `3600000` | Cache TTL in milliseconds (default: 1 hour) |

**Performance Tips:**
- Set `USE_SERPER_ONLY=true` for fastest Serper API responses (skips browser fallbacks)
- Increase `SEARCH_ENGINE_MAX_RPM` if you have a higher Serper tier limit
- Use `SEMANTIC_CACHE_ENABLED=false` to disable caching and always fetch fresh results

---

## 🛠️ MCP Tools Reference

### Primary Search Tools
- `full-web-search`: Comprehensive research. Returns top results with full, cleaned Markdown content.
- `get-web-search-summaries`: Lightweight search. Returns snippets/descriptions without heavy extraction.
- `progressive-web-search`: Advanced research. Uses query expansion and multiple engines for complex topics.
- `cached-web-search`: Intelligent search. Uses semantic caching to provide instant results for similar queries.

### Specialized Extractors
- `get-single-web-page-content`: Targeted extraction from a specific URL.
- `get-github-repo-content`: Deeply crawls and extracts code/READMEs from GitHub repositories.
- `get-pdf-content`: Extracts readable text from PDF documents (with browser fallback).
- `get-openapi-spec`: Automatically discovers and downloads OpenAPI/Swagger specifications.

### Discovery & Management
- `get-website-sitemap`: Discovers all available URLs on a domain via its sitemap.
- `filter-sitemap-urls`: Filters sitemap results by keywords to find high-value pages.
- `get-github-directory-contents`: Lists files/folders within a specific GitHub path.
- `list-cached-documents`: Lists all previously crawled documents and specs stored in the local cache.

---

## ⚖️ License

This project is part of the [LeanZero](https://leanzero.atlascrafted.com) ecosystem by AtlasCraft. See LICENSE file for details.
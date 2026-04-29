# Web Search MCP Server

**A high-performance, production-ready web search orchestration system specifically engineered for local AI agents.**

> **Note:** This is a fork of [mrkrsl/web-search-mcp](https://github.com/mrkrsl/web-search-mcp) with significantly enhanced orchestration, enterprise guardrails, and intelligent content extraction capabilities.

---

## 🎯 Who Is This For?

This server is built for **Local AI Users**—individuals running Large Language Models (LLMs) on their own hardware or via private instances—**and the Atlassian Forge apps that talk to them.**

- ✅ **Cline / Roo Code Users**: Perfect for autonomous coding agents that need to research documentation or libraries.
- ✅ **Claude Desktop Users**: Seamlessly add web browsing capabilities to your local Claude interface.
- ✅ **LM Studio Users**: First-class non-agent client support — content is embedded inline (no sibling filesystem MCP required) so the LLM can actually use the results.
- ✅ **Atlassian Forge App Developers**: Reach this MCP from any Forge app — Jira, Confluence, Bitbucket, Compass, Jira Service Management — by routing through the user's self-hosted LM Studio over Tailscale Funnel. **No HTTP transport, no auth surface, no per-app egress to manage.** A reference implementation ships in [CogniRunner](https://marketplace.atlassian.com/apps/298437877/cognirunner). [→ Forge integration guide](#-using-this-mcp-from-an-atlassian-forge-app).
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
      "timeout": 120000,
      "trust": true,
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
      "timeout": 120000,
      "trust": true,
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
| `SERPER_API_KEY` | *none* | Required for the (default) Serper-first fast path |
| `SEARCH_ENGINE_MAX_RPM` | `50` | Max requests per minute to the search engine |
| `SEARCH_ENGINE_RESET_MS` | `60000` | Reset window for RPM in milliseconds |
| `DEBUG_BING_SEARCH` | `false` | Set to `true` for verbose Bing parsing logs |
| `USE_SERPER_ONLY` | `true` | **Performance**: Skip Playwright browser fallbacks (the default). Set `false` to enable browser fallbacks. |
| `ENABLE_BROWSER_FALLBACKS` | `false` | Legacy alias; setting `true` overrides `USE_SERPER_ONLY` and turns on browser engines |
| `PARALLEL_SEARCH` | `true` | Enable parallel engine searches (disable for faster single-engine) |
| `SERPER_BREAKER_FAILURES` | `5` | Consecutive Serper failures before the circuit breaker opens |
| `SERPER_BREAKER_COOLDOWN_MS` | `30000` | How long the breaker stays open before allowing a probe |

### 📄 Content Extraction & Quality
| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_CONTENT_LENGTH` | `100000` | Max characters per page (lowered from 500 KB — 5 MB total per 10-result search drove GC pressure) |
| `MIN_CONTENT_LENGTH` | `200` | Minimum bytes required for a valid result |
| `DEFAULT_TIMEOUT` | `6000` | Timeout for extraction in ms |
| `EXTRACT_CONCURRENCY` | `3` | Max parallel page extractions per search (prevents N concurrent browser launches) |
| `BROWSER_FALLBACK_THRESHOLD`| `3` | Failures before switching to headless browser |
| `ENABLE_RELEVANCE_CHECKING` | `true` | Enables AI-ready quality scoring |
| `RELEVANCE_THRESHOLD` | `0.3` | Minimum score (0.0-1.0) for valid content |

### ⏱️ Per-tool wall-clock budgets (ms)
All defaults sit below ~20 s so the upstream `Forge → LM Studio → MCP` chain
fits within Forge's ~25 s function timeout. Override only if the deployment
needs different ceilings.

| Variable | Default |
|----------|---------|
| `TOOL_TIMEOUT_FULL_SEARCH` | `18000` |
| `TOOL_TIMEOUT_SEARCH_SUMMARIES` | `8000` |
| `TOOL_TIMEOUT_SINGLE_PAGE` | `12000` |
| `TOOL_TIMEOUT_PDF` | `12000` |
| `TOOL_TIMEOUT_GITHUB` | `18000` |
| `TOOL_TIMEOUT_OPENAPI` | `15000` |
| `TOOL_TIMEOUT_PROGRESSIVE` | `20000` |

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

## 🤖 Client-Aware Tool Behavior

This server detects the calling MCP client at the `initialize` handshake (via
`getClientVersion()`) and adapts tool output accordingly. Two cohorts:

| Cohort | Examples | What they get |
|---|---|---|
| **Agentic** | Cline, Claude Desktop, Roo Code, Continue, claude-ai | Compact responses. Disk-write tools (`research_and_save_to_markdown`, `get-openapi-spec`) return only the file path — these clients have a sibling filesystem MCP and will read the file themselves. |
| **Non-agent** | LM Studio, MCP Inspector, anything not on the whitelist | Full content embedded inline (truncated to fit `MAX_OUTPUT_LENGTH`). The LLM gets a usable result without needing filesystem access. |

The whitelist is a strict prefix match against `clientInfo.name` — see
`src/client-detect.ts`. **Default is non-agent**, so an unknown caller is
served the safe (inline) shape rather than an unreachable file path.

Verified end-to-end. Calling `get-openapi-spec` against the Petstore JSON spec
with two different `clientInfo.name` values:

| `clientInfo.name` | Response size | Inline spec | `isError` |
|---|---|---|---|
| `Cline` | 788 bytes | no | false |
| `lm-studio` | ~26 KB | yes (full spec in fenced block) | false |

Same tool, same arguments, same backend — the only thing that changed is the
client identity.

---

## 🧩 Using This MCP From an Atlassian Forge App

Atlassian Forge apps run in a sandboxed serverless runtime that **cannot
spawn stdio child processes**, so they cannot host this MCP server directly.
The integration pattern uses the user's self-hosted LM Studio as a bridge:

```
┌──────────────────┐   HTTPS   ┌───────────────────────┐   stdio   ┌──────────────┐
│  Your Forge app  ├──────────►│  User's LM Studio     ├──────────►│  This MCP    │
│  (Jira/Conf/etc.)│   over    │  exposed via          │           │  server      │
│                  │  Tailscale│  Tailscale Funnel     │           │  (web-search)│
│                  │  Funnel   │  (https://*.ts.net)   │           │              │
└──────────────────┘           └───────────────────────┘           └──────────────┘
```

**Why this works**: LM Studio's native `/api/v1/chat` endpoint accepts an
`integrations` array that loads MCP servers from the user's local `mcp.json`.
Your Forge app sends a chat completion with `integrations: [{ id: "mcp/web-search", allowed_tools: [...] }]`
and LM Studio invokes this MCP via stdio on the user's machine. Forge never
talks to this MCP directly — it talks to LM Studio.

**Why this is a selling point**:

- **Zero per-app egress complexity.** Your Forge `manifest.yml` declares one
  egress entry (`*.ts.net`) and you reach any number of MCP servers the user
  has registered locally. No need to whitelist the MCP server's own host —
  it never needs to be publicly reachable.
- **No auth surface to defend.** This MCP server has no HTTP transport. The
  only network boundary is the user's own Tailscale Funnel (which Tailscale
  authenticates) and LM Studio's optional API token. Nothing to compromise
  on the MCP side.
- **Tool-level allowlisting.** Curate exactly which tools your Forge app can
  invoke per integration. The user can have other MCPs in their `mcp.json`;
  your app sees only what you allowlist.
- **Privacy by design.** Field content (Jira issues, Confluence pages,
  Bitbucket diffs) flows from your Forge app to the user's own machine and
  out to the model — never through a SaaS aggregator you don't control.
- **Marketplace-friendly.** AGPL-licensed reference implementation already
  on the Atlassian Marketplace — see [CogniRunner](https://marketplace.atlassian.com/apps/298437877/cognirunner).

### Integration recipe

#### 1. Declare egress in `manifest.yml`

```yaml
permissions:
  external:
    fetch:
      backend:
        - address: "*.ts.net"   # Tailscale Funnel — user's LM Studio
      client:
        - address: "*.ts.net"
```

#### 2. Document the user-side `mcp.json` snippet your app expects

Tell your users to add this block to their LM Studio `mcp.json`:

```json
{
  "mcpServers": {
    "web-search": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mcp-web-search/dist/index.js"],
      "env": {
        "SERPER_API_KEY": "<key>",
        "USE_SERPER_ONLY": "true",
        "MAX_CONTENT_LENGTH": "100000",
        "EXTRACT_CONCURRENCY": "3"
      }
    }
  }
}
```

The key (`web-search`) is the integration label your Forge app references.
Pick whatever label fits your domain — just keep it consistent on both sides.

#### 3. Call LM Studio's native chat endpoint with the `integrations` array

```js
// In your Forge resolver (running on Atlassian's Forge runtime):
import api, { route } from '@forge/api';

const baseUrl = await storage.get('LMSTUDIO_BASE_URL');  // user-configured: https://machine.tailXXXX.ts.net
const apiKey  = await storage.get('LMSTUDIO_API_KEY');   // optional

const response = await fetch(`${baseUrl}/api/v1/chat`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
  },
  body: JSON.stringify({
    model: 'your-chosen-model',
    input: 'Find the public Jira REST API rate limit.',
    integrations: [
      {
        type: 'plugin',
        id: 'mcp/web-search',                      // matches mcp.json key
        allowed_tools: [                           // curate per app
          'get-web-search-summaries',
          'full-web-search',
          'get-single-web-page-content',
          'get-pdf-content',
        ],
      },
    ],
  }),
});
```

#### 4. (Optional) Verify the user's `mcp.json` is wired up

Send a tiny one-token chat with the integration enabled. If the user's
`mcp.json` is missing the entry, LM Studio returns a 4xx with an "unknown
plugin" message you can surface in your admin UI. CogniRunner's
`pingLmStudioMcp` resolver does this — copy the pattern.

### What you should NOT do

- **Don't** try to run this MCP server inside Forge. Forge can't spawn
  stdio children; this MCP has no HTTP transport (deliberately — see
  Threat model below).
- **Don't** point your Forge app at `localhost`, `127.0.0.1`, or any
  RFC1918 address. Forge cannot reach them, and even if it could, this
  MCP's SSRF guard would refuse the URLs forwarded through tool calls.
  Always use Tailscale Funnel (`*.ts.net`) — those addresses resolve to
  Tailscale's public relays and pass the SSRF guard.
- **Don't** rely on a tool being available unless you allowlist it in the
  `integrations[].allowed_tools` array. The full surface of this server
  (11 tools) is overkill for any single Forge app — pick 3-5 that map to
  your use case.

### Reference implementation: CogniRunner

[CogniRunner](https://marketplace.atlassian.com/apps/298437877/cognirunner)
is the first production Forge app using this pattern. It's
[AGPL-licensed open source](https://github.com/mperdum/leanzero-cognirunner-forgeapp) —
clone it as a starting point. Specifically:

| What | Where in CogniRunner |
|---|---|
| `lmstudio` BYOK provider with Tailscale URL validation | `src/index.js:1743-1817` |
| MCP integration registry (`SUPPORTED_MCPS`) | `src/index.js:2289-2319` |
| Per-MCP ping/probe resolver | `src/index.js:2380` |
| Native `/api/v1/chat` request including `integrations` | `src/index.js:4197-4279` |

If you want this MCP to integrate with another Atlassian (or non-Atlassian)
host, the same recipe applies — Forge isn't special, it just happens to be
where the proof of concept lives.

### Threat model

The decision to NOT add an HTTP transport is intentional:

- HTTP would mean an exposed listener, an auth surface, TLS, rate limiting,
  CORS, and DDoS exposure on the MCP side.
- The bridge model puts those concerns on Tailscale (zero-trust mesh,
  auth at the funnel) and LM Studio (optional API token, request-rate
  limited by LM Studio itself), which both already solve them.
- The only thing the MCP server sees is stdio frames from a local LM
  Studio process running as the user — same trust boundary as any other
  CLI tool the user runs.

If you have a use case that really needs direct HTTP access (e.g.,
non-LM-Studio host, or you want to bypass the local AI), open an issue.

---

## 🛠️ MCP Tools Reference

11 tools total (down from 13 after the round-2 consolidation).

### Primary Search Tools
- `full-web-search`: Comprehensive research. Returns top results with full, cleaned Markdown content. Semantic cache is in this path; cache hits show as `engine: semantic-cache` in the response.
- `get-web-search-summaries`: Lightweight search. Returns snippets/descriptions without heavy extraction.
- `progressive-web-search`: Advanced research. Uses query expansion and multiple engines for complex topics.

### Specialized Extractors
- `get-single-web-page-content`: Targeted extraction from a specific URL.
- `get-github-repo-content`: Three modes via `mode: 'crawl' | 'list' | 'file'`. Default `crawl` walks the repo and returns README + per-file previews (configurable via `previewLength`, default 500, max 5000). Use `list` for a one-directory listing or `file` with `path` for full content of a single file.
- `get-pdf-content`: Extracts readable text from PDF documents (with browser fallback).
- `get-openapi-spec`: Discovers and downloads OpenAPI/Swagger specs (JSON and YAML). For non-agent clients (LM Studio), the spec content is also embedded inline up to `OPENAPI_INLINE_CAP` (default 50 KB).
- `research_and_save_to_markdown`: Researches URLs and writes a markdown file per result. For non-agent clients, the markdown is also embedded inline so LM Studio can read it without filesystem access.

### Discovery & Management
- `get-website-sitemap`: Discovers all URLs in a sitemap. Pass `keywords?: string[]` to filter by keyword (replaces the former `filter-sitemap-urls` tool). Pass `extractTopMatching?: number` (1..5) to also extract content from the top N matches in the same call — collapses the sitemap → filter → extract chain into one round-trip.
- `list-cached-documents`: Lists OpenAPI specs and research markdown files previously saved on disk. Filter via `category: 'all' | 'openapi' | 'research'`.
- `read-cached-document`: Returns a previously-cached document's content inline by file name (as listed by `list-cached-documents`). Refuses path-traversal characters.

---

## 🛠️ Troubleshooting

### Timeout Errors in Qwen Code / MCP Clients

If you see **"Request timed out" (-32001)** errors:

**Cause:** The default timeout may be too short for complex web searches or large content extractions.

**Solution:** Add a `timeout` setting to your MCP server configuration. This is **milliseconds**, not seconds!

#### Correct Configuration Example:
```json
{
  "mcpServers": {
    "web-search": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mcp-web-search/dist/index.js"],
      "timeout": 120000,
      "trust": true,
      "env": {
        "SEARCH_ENGINE": "brave"
      }
    }
  }
}
```

**Key Points:**
- `timeout` is in **milliseconds**: `60000` = 60 seconds, `120000` = 2 minutes
- Set higher timeouts (e.g., `120000`) for swarm operations or large repo crawling
- Without this setting, Qwen Code uses a default of ~30 seconds which is often too short

---

## ⚖️ License

This project is part of the [LeanZero](https://leanzero.atlascrafted.com) ecosystem by AtlasCraft. See LICENSE file for details.
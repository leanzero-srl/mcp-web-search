# MCP Tool Reference

Complete documentation for all available MCP tools in the Web Search server.

---

## Overview

The server provides **12 specialized tools** for different use cases:

---

### Primary Tools (5)
| Tool | Type | Use When |
|------|------|----------|
| `full-web-search` | Primary | Comprehensive research with full content |
| `get-web-search-summaries` | Lightweight | Quick search without content extraction |
| `progressive-web-search` | Advanced | Complex research with query expansion |
| `cached-web-search` | Intelligent | Repeated or related queries |
| `get-github-repo-content` | Repository | Analyze GitHub projects |

---

### Discovery & Orchestration Tools (4)
| Tool | Type | Use When |
|------|------|----------|
| `get-website-sitemap` | Discovery | Discover all URLs on a website (Sitemap) |
| `filter-sitemap-urls` | Orchestration | Filter sitemap URLs by keywords |
| `get-github-directory-contents` | Repository | List files/directories in GitHub path |
| `list-cached-documents` | Utility | List all cached documents/specs |

---

### Specialized Tools (3)
| Tool | Type | Use When |
|------|------|----------|
| `get-single-web-page-content` | Utility | Extract from known URL |
| `get-pdf-content` | Document | Extract text from PDFs |
| `get-openapi-spec` | API Docs | Download OpenAPI specifications |

---

## Tool Details

### 1. full-web-search

**Primary tool for comprehensive web research**

**Description**: Search the web and fetch complete page content from top results. This is the most comprehensive web search tool that searches the web and then follows the resulting links to extract their full page content.

**When to Use**:
- You need detailed information with full page content
- Searching for complex topics requiring deep analysis
- You want to verify information across multiple sources

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Search query to execute (required)"
    },
    "limit": {
      "type": "number",
      "default": 5,
      "minimum": 1,
      "maximum": 10
    },
    "includeContent": {
      "type": "boolean",
      "default": true
    },
    "maxContentLength": {
      "type": "number",
      "optional": true
    }
  },
  "required": ["query"]
}
```

**Example Usage**:
```json
{
  "name": "full-web-search",
  "arguments": {
    "query": "TypeScript MCP server implementation guide",
    "limit": 5,
    "includeContent": true
  }
}
```

---

### 2. get-web-search-summaries

**Lightweight alternative for quick search results**

**Description**: Search the web and return only search result snippets/descriptions without following links to extract full page content.

**When to Use**:
- You need quick search results
- Content extraction is not required
- You want to save time and resources

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Search query to execute (required)"
    },
    "limit": {
      "type": "number",
      "default": 5,
      "minimum": 1,
      "maximum": 10
    }
  },
  "required": ["query"]
}
```

**Example Usage**:
```json
{
  "name": "get-web-search-summaries",
  "arguments": {
    "query": "latest JavaScript frameworks 2026",
    "limit": 3
  }
}
```

---

### 3. get-single-web-page-content

**Extract content from a specific URL**

**Description**: Extract and return the full content from a single web page URL. Useful for getting detailed content from a known webpage without performing a search.

**When to Use**:
- You have a specific URL to extract
- Content from one known source is needed
- Quick extraction without search overhead

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "format": "uri",
      "description": "The URL of the web page (required)"
    },
    "maxContentLength": {
      "type": "number",
      "optional": true
    }
  },
  "required": ["url"]
}
```

**Example Usage**:
```json
{
  "name": "get-single-web-page-content",
  "arguments": {
    "url": "https://developer.mozilla.org/docs/Web/API",
    "maxContentLength": 5000
  }
}
```

---

### 4. progressive-web-search

**Advanced search with automatic query expansion**

**Description**: Advanced web search that first tries the exact user query, then progressively expands using synonyms, related terms, and alternative phrasings if good results aren't found.

**When to Use**:
- Complex research where exact wording may not match best sources
- Exploratory searches with不确定 terminology
- Multi-faceted queries needing different phrasings

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Search query to execute (required)"
    },
    "maxDepth": {
      "type": "number",
      "default": 3,
      "minimum": 1,
      "maximum": 5
    },
    "limit": {
      "type": "number",
      "default": 10,
      "minimum": 1,
      "maximum": 20
    }
  },
  "required": ["query"]
}
```

**Example Usage**:
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

**How It Works**:
1. **Stage 1**: Literal search with original query
2. **Stage 2+**: Semantic expansion (synonyms, related terms)
3. **Stage 3+**: Topic deepening (related concepts)
4. Results are scored and sorted by relevance

---

### 5. cached-web-search

**Search with intelligent semantic caching**

**Description**: Search the web using intelligent caching that checks if similar queries have been recently searched and returns cached results when available.

**When to Use**:
- Repeated or related queries (saves API calls)
- Reducing latency for frequently accessed information
- Development/testing to save resources

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Search query to execute (required)"
    },
    "limit": {
      "type": "number",
      "default": 5,
      "minimum": 1,
      "maximum": 10
    },
    "includeContent": {
      "type": "boolean",
      "default": true
    },
    "maxContentLength": {
      "type": "number",
      "optional": true
    }
  },
  "required": ["query"]
}
```

**Example Usage**:
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

---

### 6. get-github-repo-content

**Crawl GitHub repository structure**

**Description**: Extract and return content from a GitHub repository including README.md and code files (.js, .ts, .py, etc.).

**When to Use**:
- Understanding project structure of a GitHub repo
- Analyzing codebase contents
- Getting README documentation

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "format": "uri",
      "description": "GitHub repository URL (required)"
    },
    "maxDepth": {
      "type": "number",
      "default": 3,
      "optional": true
    },
    "maxFiles": {
      "type": "number",
      "default": 50,
      "optional": true
    }
  },
  "required": ["url"]
}
```

**Example Usage**:
```json
{
  "name": "get-github-repo-content",
  "arguments": {
    "url": "https://github.com/microsoft/TypeScript",
    "maxDepth": 2,
    "maxFiles": 20
  }
}
```

---

### 7. get-pdf-content

**Extract text from PDF documents**

**Description**: Extract and return text content from a PDF document using HTTP-based extraction with browser fallback.

**When to Use**:
- Extracting from research papers
- Reading documentation available as PDF
- Getting content from academic sources

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "format": "uri",
      "description": "PDF file URL (required)"
    },
    "maxContentLength": {
      "type": "number",
      "optional": true
    }
  },
  "required": ["url"]
}
```

**Example Usage**:
```json
{
  "name": "get-pdf-content",
  "arguments": {
    "url": "https://arxiv.org/pdf/2305.12345.pdf",
    "maxContentLength": 5000
  }
}
```

---

### 8. get-openapi-spec

**Download OpenAPI specifications**

**Description**: Extract and download OpenAPI/Swagger specifications from API documentation pages, saving them to `docs/technical/openapi/` for future use.

**When to Use**:
- Downloading API documentation
- Working with REST APIs
- Analyzing endpoint structures

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "format": "uri",
      "description": "API documentation URL (required)"
    },
    "forceRefresh": {
      "type": "boolean",
      "default": false,
      "optional": true
    }
  },
  "required": ["url"]
}
```

**Example Usage**:
```json
{
  "name": "get-openapi-spec",
  "arguments": {
    "url": "https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/",
    "forceRefresh": false
  }
}
```

---

## Response Format

All tools return responses in this format:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Your search results or content here..."
    }
  ]
}
```

The text content is formatted with markdown-style headers for easy parsing.

---

---

## Performance Comparison

### Search Tools
| Tool | Speed | Content Depth | Resource Usage |
|------|-------|---------------|----------------|
| `get-web-search-summaries` | ⚡⚡⚡ Fastest | Low | Low |
| `cached-web-search` | ⚡⚡⚡ Fast* | Medium | Low* |
| `full-web-search` | ⚡ Medium | High | High |
| `progressive-web-search` | ⚡ Slow | Very High | High |

### Extraction Tools
| Tool | Speed | Content Depth | Resource Usage |
|------|-------|---------------|----------------|
| `get-single-web-page-content` | ⚡⚡ Medium | Medium | Medium |
| `get-pdf-content` | ⚡ Medium | Medium | Medium |
| `get-github-repo-content` | ⚡⚡ Medium | High | Medium |

### Discovery/Orchestration Tools
| Tool | Speed | Content Depth | Resource Usage |
|------|-------|---------------|----------------|
| `get-website-sitemap` | ⚡⚡⚡ Fastest | Low | Low |
| `filter-sitemap-urls` | ⚡⚡⚡ Fastest | Low | Low |
| `list-cached-documents` | ⚡⚡⚡ Fastest | None | None |

*When cache hit occurs

---

### 9. get-website-sitemap

**Discover all URLs on a website (Sitemap)**

**Description**: Discover and list all available page URLs on a website by reading its sitemap.xml file. This is the **RECOMMENDED FIRST STEP** when researching a specific domain, especially for large corporate websites.

**When to Use**:
- You have a domain URL and need to discover its structure
- Researching large corporate websites (e.g., Sanofi, Microsoft)
- You want to understand what pages are available before extracting content

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "format": "uri",
      "description": "Base URL of the website (e.g., https://example.com)"
    }
  },
  "required": ["url"]
}
```

**Response Format**:
- Returns up to 100 URLs with pagination indicator
- Includes **Tiered Guidance** based on URL count:
  - **< 20 URLs**: Suggests direct extraction
  - **20-100 URLs**: Recommends filtering or manual selection
  - **> 100 URLs**: Strongly recommends using `filter-sitemap-urls`

**Example Usage**:
```json
{
  "name": "get-website-sitemap",
  "arguments": {
    "url": "https://www.example-corporate-site.com"
  }
}
```

---

### 10. filter-sitemap-urls

**Filter sitemap URLs by keywords**

**Description**: Filter a website's sitemap to find high-value pages based on specific keywords. This is essential for **orchestrating** research on large sites where extracting all URLs would be inefficient.

**When to Use**:
- After `get-website-sitemap` returns >100 URLs
- You need to focus on specific sections (e.g., "about", "products", "strategy")
- You want to avoid context overflow from too many extractions

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "format": "uri",
      "description": "Base URL of the website"
    },
    "keywords": {
      "type": "array",
      "items": {"type": "string"},
      "description": "Keywords to match in URLs (e.g., ['about', 'company', 'strategy'])"
    },
    "limit": {
      "type": "number",
      "default": 20,
      "optional": true
    }
  },
  "required": ["url", "keywords"]
}
```

**Example Usage**:
```json
{
  "name": "filter-sitemap-urls",
  "arguments": {
    "url": "https://www.example-corporate-site.com",
    "keywords": ["about", "company", "strategy", "mission"],
    "limit": 15
  }
}
```

---

### 11. get-github-directory-contents

**List files/directories in GitHub repo path**

**Description**: List the files and directories within a specific path of a GitHub repository. This is useful for exploring repository structure before fetching specific file contents.

**When to Use**:
- You need to explore a GitHub repo structure
- You want to list contents of a specific directory
- Preparing to extract specific files from a known path

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "format": "uri",
      "description": "GitHub repository URL"
    },
    "path": {
      "type": "string",
      "optional": true,
      "description": "Path within repository (e.g., 'docs/technical')"
    },
    "branch": {
      "type": "string",
      "optional": true,
      "description": "Branch name (default: main)"
    }
  },
  "required": ["url"]
}
```

**Example Usage**:
```json
{
  "name": "get-github-directory-contents",
  "arguments": {
    "url": "https://github.com/microsoft/TypeScript",
    "path": "src",
    "branch": "main"
  }
}
```

---

### 12. list-cached-documents

**List all cached documents/specs**

**Description**: List all documents that have been crawled and saved by this MCP server, including OpenAPI specifications and technical documentation.

**When to Use**:
- You want to see what has already been downloaded
- Avoiding re-crawling previously fetched content
- Managing cache storage

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "category": {
      "type": "string",
      "enum": ["openapi", "technical-md", "all"],
      "default": "all",
      "optional": true
    }
  }
}
```

**Example Usage**:
```json
{
  "name": "list-cached-documents",
  "arguments": {
    "category": "openapi"
  }
}
```

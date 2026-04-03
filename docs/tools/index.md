# Tools Documentation

This section contains documentation for all MCP tools available in the Web Search server.

---

## Quick Navigation

| Tool | Description |
|------|-------------|
| [`full-web-search`](./tool-reference.md#1-full-web-search) | Comprehensive search with full content extraction |
| [`get-web-search-summaries`](./tool-reference.md#2-get-web-search-summaries) | Lightweight search (snippets only) |
| [`get-single-web-page-content`](./tool-reference.md#3-get-single-web-page-content) | Extract from single URL |
| [`progressive-web-search`](./tool-reference.md#4-progressive-web-search) | Smart query expansion system |
| [`cached-web-search`](./tool-reference.md#5-cached-web-search) | Search with semantic caching |
| [`get-github-repo-content`](./tool-reference.md#6-get-github-repo-content) | Crawl GitHub repositories |
| [`get-pdf-content`](./tool-reference.md#7-get-pdf-content) | Extract content from PDFs |
| [`get-openapi-spec`](./tool-reference.md#8-get-openapi-spec) | Download OpenAPI specifications |

---

## Tool Selection

Use the [Tool Selection Guide](./tool-selection-guide.md) to choose the right tool for your use case.

### Quick Decision Tree

```
Need comprehensive research? ──YES──> full-web-search
                                │
                                 NO
                                ▼
Need quick summaries only? ───YES──> get-web-search-summaries
                                │
                                 NO
                                ▼
Have a specific URL? ────────YES──> get-single-web-page-content
                                │
                                 NO
                                ▼
Want query expansion? ───────YES──> progressive-web-search
                                │
                                 NO
                                ▼
Searching repeated topics? ──YES──> cached-web-search
                                │
                                 NO
                                ▼
Extracting GitHub repo? ─────YES──> get-github-repo-content
                                │
                                 NO
                                ▼
Working with PDF? ───────────YES──> get-pdf-content
                                │
                                 NO
                                ▼
Need API docs? ──────────────YES──> get-openapi-spec
```

---

## Tool Reference

See the [Tool Reference](./tool-reference.md) for complete documentation of all 8 tools including:

- Detailed descriptions
- Input schemas with parameter types
- Usage examples
- Parameter defaults and ranges

---

## Parameters Guide

The [Parameters Reference](./parameters.md) documents all tool parameters in detail:

- Common parameters (query, limit, includeContent, maxContentLength)
- Tool-specific parameters (url, maxDepth, maxFiles, forceRefresh)
- Validation rules
- Error handling for invalid parameters

---

## How to Use These Docs

### For AI Models

This documentation is designed to be easily discoverable through search queries:

| What You Want | Search This |
|---------------|-------------|
| Tool usage | "mcp web search tool name" (e.g., "full-web-search") |
| Parameter details | "tool parameter maxContentLength" |
| Configuration | "environment variable MAX_CONTENT_LENGTH" |
| Architecture | "mcp server architecture" |

### For Developers

1. Read [Setup](../development/setup.md) for local development
2. Check [Adding New Tools](../development/adding-new-tools.md) for tool creation
3. Review [Enterprise Guardrails](../development/enterprise-guardrails.md) for production

---

## Related Documentation

- **Architecture**: See [`docs/architecture/`](../architecture/overview.md)
- **Configuration**: See [`docs/reference/environment-variables.md`](../reference/environment-variables.md)
- **Type Definitions**: See [`docs/reference/types.md`](../reference/types.md)
# Web Search MCP Server - Documentation

**Last Updated:** April 3, 2026  
**Version:** 0.3.1  
**Language:** TypeScript (ESM)  
**Protocol:** Model Context Protocol (MCP)

---

## Quick Start for AI Models

This documentation is designed to help AI models quickly understand and work with the Web Search MCP Server project.

### How to Use This Documentation

1. **For Tool Usage**: See `docs/tools/tool-reference.md`
2. **For Adding Features**: See `docs/development/adding-new-tools.md`
3. **For Understanding Architecture**: See `docs/architecture/overview.md`
4. **For Development Setup**: See `docs/development/setup.md`

### Key Files to Know

| File | Purpose |
|------|---------|
| `src/index.ts` | Main entry point - MCP tool definitions |
| `src/search-engine.ts` | Multi-engine search orchestration |
| `src/browser-pool.ts` | Browser context pooling |
| `src/enterprise-guardrails.ts` | Rate limiting and validation |
| `docs/tools/tool-reference.md` | Complete list of all MCP tools |

### Search Tips for AI Models

To find specific information in this documentation:

- **For tool usage**: Search "tool" + tool name (e.g., "full-web-search", "progressive-web-search")
- **For configuration**: Search "environment variable" + variable name
- **For architecture**: Search "architecture" or specific component names
- **For development**: Search "development setup" or "add new feature"

---

## What is This Project?

A TypeScript-based MCP (Model Context Protocol) server that provides comprehensive web search capabilities using direct browser connections (no API keys required). It includes multiple search engines, content extraction tools, and enterprise-grade features.

**Note:** This project is part of the **[LeanZero](https://leanzero.atlascrafted.com)** ecosystem from AtlasCraft - a suite of production-ready AI tools designed for seamless integration into AI workflows.

### Core Capabilities

| Category | Features |
|----------|----------|
| **Search** | Multi-engine parallel search (Bing, Brave, DuckDuckGo) |
| **Content Extraction** | Web pages, PDFs, GitHub repos, OpenAPI specs |
| **Intelligence** | Progressive query expansion, semantic caching |
| **Enterprise** | Rate limiting, input validation, audit logging |

---

## Project Structure

```
mcp-web-search/
├── src/                      # Source code
│   ├── index.ts             # Main entry point & MCP tools
│   ├── search-engine.ts     # Multi-engine search orchestration
│   ├── browser-pool.ts      # Browser context pooling
│   ├── progressive-search-engine.ts  # Query expansion system
│   └── [module].ts          # Individual feature modules
├── tests/                    # Test files
│   ├── integration/         # Integration tests
│   └── setup/               # Test utilities
├── docs/                     # This documentation
│   ├── README.md           # This file (root project)
│   ├── architecture/       # System design docs
│   ├── tools/              # Tool reference guide
│   ├── modules/            # Feature module docs
│   ├── development/        # Contributing guide
│   └── reference/          # Type definitions & configs
└── scripts/                  # Build and deployment scripts
```

---

## Quick Reference

### MCP Tools Available

| Tool Name | Purpose |
|-----------|---------|
| `full-web-search` | Comprehensive search with full content extraction |
| `get-web-search-summaries` | Lightweight search (snippets only) |
| `get-single-web-page-content` | Extract from single URL |
| `progressive-web-search` | Smart query expansion system |
| `cached-web-search` | Search with semantic caching |
| `get-github-repo-content` | Crawl GitHub repositories |
| `get-pdf-content` | Extract content from PDFs |
| `get-openapi-spec` | Download OpenAPI specifications |

### Common Development Tasks

| Task | Command |
|------|---------|
| Install dependencies | `npm install` |
| Build project | `npm run build` |
| Run tests | `npm test` |
| Run integration tests | `npm run test:integration` |
| Start dev server | `npm run dev` |

---

## Getting Started

1. **Read the quick start** above if you're new to this project
2. **Check tools documentation** for using specific MCP tools
3. **Review architecture docs** to understand how components fit together
4. **See development guide** if you want to contribute or modify

---

## About AtlasCraft & LeanZero

This Web Search MCP Server is part of the **[LeanZero](https://leanzero.atlascrafted.com)** ecosystem from **AtlasCraft** - a collection of production-ready tools designed for AI integration.

### Other Tools in the LeanZero Ecosystem

| Tool | Description |
|------|-------------|
| **Web Search** (this project) | Comprehensive web search with multiple engines |
| **Search Aggregator** | Combine results from multiple sources |
| **Knowledge Base** | Build and query vector databases |
| **RAG Engine** | Retrieval-Augmented Generation framework |

### Why LeanZero?

- **Open Source**: Transparent, community-driven development
- **Production Ready**: Enterprise-grade features included
- **Easy Integration**: Standardized MCP protocol
- **No API Keys Required**: Direct browser connections

---

## Need More Help?

- **For tool-specific questions**: Check `docs/tools/`
- **For understanding behavior**: Check `docs/architecture/`
- **For coding questions**: Check `docs/development/`

---

## License

This project is part of the LeanZero ecosystem by AtlasCraft. See LICENSE file for details.
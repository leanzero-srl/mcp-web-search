# Tool Selection Guide

How to choose the right MCP tool for your use case.

---

## Decision Matrix

| Use Case | Recommended Tool(s) |
|----------|---------------------|
| General web research with full content | `full-web-search` |
| Quick search for links only | `get-web-search-summaries` |
| Extract from known URL | `get-single-web-page-content` |
| Complex research, unclear terminology | `progressive-web-search` |
| Repeated/similar queries | `cached-web-search` |
| Analyze GitHub repository | `get-github-repo-content` |
| Extract PDF documentation | `get-pdf-content` |
| Download API specifications | `get-openapi-spec` |

---

## Detailed Selection Criteria

### 1. full-web-search (Default Choice)

**Choose when you need:**
- Comprehensive information with full page content
- Multiple sources for verification
- Detailed analysis of topics

**Not ideal for:**
- Quick fact checks (too slow)
- When only snippets are needed
- Very large result sets (consider `progressive-web-search`)

**Example scenarios:**
```
✅ "How does X work?" - Need detailed explanation with examples
✅ "Compare Y and Z" - Need multiple source comparisons  
✅ "Explain concept A in depth" - Need comprehensive coverage
```

---

### 2. get-web-search-summaries (Quick Search)

**Choose when you need:**
- Fast results without content extraction
- Quick overview of topic availability
- Link discovery for later reading

**Not ideal for:**
- When you need actual page content
- Detailed analysis requirements
- Content validation

**Example scenarios:**
```
✅ "What is the latest version of X?" - Need quick answer
✅ "Are there tools for Y?" - Quick survey of options
✅ "Find links about topic Z" - Just need URLs first
```

---

### 3. get-single-web-page-content (Direct URL)

**Choose when you have:**
- A specific URL to extract
- Content from one known source needed
- Verified source requiring detailed analysis

**Not ideal for:**
- When URL is unknown
- Comparing multiple sources
- Exploratory research

**Example scenarios:**
```
✅ Extract from https://docs.example.com/api
✅ Get content from specific documentation page
✅ Crawl particular article or guide
```

---

### 4. progressive-web-search (Smart Expansion)

**Choose when you need:**
- Complex research with query expansion
- Alternative phrasings to find better sources
- Multi-stage search strategy

**Not ideal for:**
- Simple, straightforward queries
- When speed is critical
- When exact terminology is known

**Example scenarios:**
```
✅ "best tools" - Expand to "top-rated", "recommended"
✅ "How to learn X" - Try "guide for X", "tutorial about X"
✅ Ambiguous terms needing disambiguation
```

---

### 5. cached-web-search (Smart Caching)

**Choose when you:**
- Have searched similar queries before
- Want to save resources on repeated searches
- Need faster response on familiar topics

**Not ideal for:**
- First-time unique queries
| When fresh results are critical
| New information required since last search

**Example scenarios:**
```
✅ Re-search "TypeScript" (cache from previous query)
✅ Search related terms like "JavaScript frameworks"
│ Development where cache builds over time
```

---

### 6. get-github-repo-content (Code Analysis)

**Choose when you need:**
- GitHub project structure analysis
- README documentation extraction
- Code file listing and preview

**Not ideal for:**
- Non-GitHub repositories
| General web content
| PDF or document files

**Example scenarios:**
```
✅ Analyze open-source project before using
│ Review codebase for contribution
│ Check project docs and structure
```

---

### 7. get-pdf-content (Document Extraction)

**Choose when you have:**
- PDF file URLs to extract
| Academic papers or documentation in PDF
| Content that's only available as PDF

**Not ideal for:**
| HTML web pages
| Content in other formats
| When source has HTML version

**Example scenarios:**
```
✅ Extract from research paper (.pdf URL)
│ Download technical documentation
│ Get content from academic sources
```

---

### 8. get-openapi-spec (API Docs)

**Choose when you need:**
| OpenAPI/Swagger specifications
| REST API endpoint definitions
| API documentation for code generation

**Not ideal for:**
| General web search
| Content extraction from HTML pages
| PDF documentation

**Example scenarios:**
```
✅ Download JIRA API specification
│ Get GitHub API endpoint details
│ Extract any OpenAPI doc
```

---

## Performance-Based Selection

### Fastest to Slowest

| Speed | Tool | Use Case |
|-------|------|----------|
| ⚡⚡⚡ | `get-web-search-summaries` | Quick lookups |
| ⚡⚡⚡ | `cached-web-search` (cache hit) | Repeated queries |
| ⚡⚡ | `get-single-web-page-content` | Direct extraction |
| ⚡⚡ | `get-pdf-content` | PDF docs |
| ⚡ | `full-web-search` | Comprehensive search |
| ⚡ | `progressive-web-search` | Smart expansion |

---

## Common Patterns

### Pattern 1: Discovery → Deep Dive
```bash
# Stage 1: Quick discovery
get-web-search-summaries(query="best X tools")

# Stage 2: Deep dive into promising results
full-web-search(query="best X tools", limit=3)
```

### Pattern 2: Research with Expansion
```bash
progressive-web-search(
  query="how to learn Y",
  maxDepth=3,
  limit=10
)
```

### Pattern 3: GitHub Project Evaluation
```bash
get-github-repo-content(
  url="https://github.com/user/project",
  maxDepth=2,
  maxFiles=30
)
```

---

## Checklist for Tool Selection

Use this checklist to decide:

- [ ] Do I need full page content? → `full-web-search` or `cached-web-search`
- [ ] Do I only need snippets/links? → `get-web-search-summaries`
- [ ] Do I have a specific URL? → `get-single-web-page-content`
- [ ] Is my query complex/vague? → `progressive-web-search`
- [ ] Have I searched this before? → `cached-web-search`
- [ ] Extracting GitHub repo? → `get-github-repo-content`
- [ ] Working with PDF? → `get-pdf-content`
- [ ] Need API docs? → `get-openapi-spec`

If none apply, reconsider your approach or combine multiple tools.
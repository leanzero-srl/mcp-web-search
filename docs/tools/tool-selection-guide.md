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
| Get website sitemap | `get-website-sitemap` |
| Filter sitemap URLs | `filter-sitemap-urls` |
| List cached documents | `list-cached-documents` |
| Extract PDF documentation | `get-pdf-content` |
| Get GitHub directory contents | `get-github-directory-contents` |
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

### 9. get-website-sitemap (Site Discovery)

**Choose when you need:**
- Discover all available URLs on a website
- Map out site structure before extraction
- Get complete list of pages for systematic crawling

**Not ideal for:**
- Extracting content directly (use `get-single-web-page-content` instead)
- Searching the web (use `full-web-search`)
| When you already know specific URLs

**Example scenarios:**
```
✅ Before crawling a large documentation site
✅ Understanding site architecture for research
✅ Finding all product pages on an e-commerce site
```

---

### 10. filter-sitemap-urls (URL Filtering)

**Choose when you need:**
- Narrow down sitemap URLs to specific sections
- Find high-value pages using keyword matching
- Reduce result set before content extraction

**Not ideal for:**
| General web search
| When you don't have a sitemap URL first
| Complex text matching (supports regex patterns)

**Example scenarios:**
```
✅ Filter for ['about', 'company', 'mission'] pages
✅ Find all /docs/ URLs for documentation
✅ Locate specific sections using keyword patterns
```

---

### 11. get-github-directory-contents (Directory Explorer)

**Choose when you need:**
| Browse repository structure at a specific path
| List files and directories without full extraction
| Explore GitHub repo organization

**Not ideal for:**
| Getting full file contents (use `get-github-repo-content`)
| Non-GitHub sources
| Deep code analysis requiring full crawl

**Example scenarios:**
```
✅ List contents of docs/ directory
✅ See what's in root vs src/ folder
✅ Explore repo structure before detailed analysis
```

---

### 12. list-cached-documents (Cache Management)

**Choose when you need:**
| See what documents have been previously crawled
| Audit cached content for relevance
| Manage storage and cache hygiene

**Not ideal for:**
| Finding uncached content
| Real-time web search
| Content not yet processed

**Example scenarios:**
```
✅ Review previously saved OpenAPI specs
✅ Check what technical docs are cached
✅ Clean up old cached documents
```

---

### 13. get-openapi-spec (API Docs)

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

## Tool Orchestration Patterns

Understanding how tools work together is crucial for effective web research.

### Recommended Workflow: Sitemap → Filter → Extract

For large websites, follow this orchestration pattern to maximize efficiency:

```
┌─────────────────┐
│   Stage 1       │
│ get-website-    │
│     sitemap()   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌──────────────────────────────┐
│   Stage 2       │     │ If >100 URLs: Use filter-    │
│  filter-sitemap-│────▶│ sitemap-urls with targeted   │
│      urls()     │     │ keywords like ['about',      │
└────────┬────────┘     │ 'strategy', 'products']      │
         │              └──────────────────────────────┘
         ▼
┌─────────────────┐
│   Stage 3       │
│ get-single-web- │
│    page-content │
└─────────────────┘
```

**When to use each stage:**

| Scenario | Recommended Approach |
|----------|---------------------|
| Small site (<20 URLs) | `get-website-sitemap` → Direct extraction |
| Medium site (20-100 URLs) | `get-website-sitemap` → `filter-sitemap-urls` → Extraction |
| Large site (>100 URLs) | `get-website-sitemap` → `filter-sitemap-urls` with keywords → Extraction |

### Orchestration Decision Tree

```
                    ┌─────────────────────┐
                    │  What is your goal?   │
                    └──────────┬────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
          ▼                    ▼                    ▼
    ┌──────────┐         ┌──────────┐         ┌──────────┐
    │ Site     │         │ Specific │         │ General  │
    │ Map      │         │ Page/URL │         │ Search   │
    └────┬─────┘         └────┬─────┘         └────┬─────┘
         │                    │                    │
         ▼                    ▼                    ▼
    ┌──────────┐         ┌──────────┐         ┌──────────┐
    │ How many │         │ Use      │         │ Use      │
    │ URLs?    │         │ get-     │         │ full-    │
    └────┬─────┘         │ single-  │         │ web-     │
         │               │ page-    │         │ search   │
    ┌────┴─────┐         │ content  │         │          │
    │          │         └──────────┘         └──────────┘
    ▼          ▼                    
┌──────┐  ┌──────┐
│ <20  │  │≥20   │
└──────┘  └──────┘
   │        │
   ▼        ▼
Direct   filter-
Extract  sitemap-
         urls()
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

### Pattern 4: Site-Wide Content Discovery (New)

For comprehensive site analysis, use the new orchestration tools:

```bash
# Stage 1: Discover all pages
get-website-sitemap(url="https://example.com")

# Stage 2: Filter to relevant sections
filter-sitemap-urls(
  url="https://example.com",
  keywords=["about", "products", "docs"],
  limit=20
)

# Stage 3: Extract from filtered pages
get-single-web-page-content(url="https://example.com/products/...")
```

---

### Pattern 5: GitHub Directory Analysis (New)

For targeted repository exploration:

```bash
# Get directory contents without full crawl
get-github-directory-contents(
  url="https://github.com/user/project",
  path="docs/technical",
  branch="main"
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
- [ ] Discovering website URLs? → `get-website-sitemap`
- [ ] Filtering sitemap URLs? → `filter-sitemap-urls`
- [ ] Browsing GitHub directory? → `get-github-directory-contents`
- [ ] Checking cached docs? → `list-cached-documents`

If none apply, reconsider your approach or combine multiple tools.
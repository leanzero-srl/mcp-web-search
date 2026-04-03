# Tool Parameters Reference

Complete reference for all tool parameters with descriptions and examples.

---

## Common Parameters

### query (string, required)

The search query to execute. This is the primary input for search-related tools.

**Validated**: Must be non-empty string

**Best Practices**:
- Use specific keywords for better results
- Include relevant terms to narrow scope
- Avoid overly broad queries

| Tool | Required |
|------|----------|
| full-web-search | ✅ Yes |
| get-web-search-summaries | ✅ Yes |
| progressive-web-search | ✅ Yes |
| cached-web-search | ✅ Yes |

**Examples**:
```json
{
  "query": "TypeScript MCP server"
}
```

---

### limit (number, optional, default: 5)

Number of results to return. Affects both search and content extraction.

**Validated**: Must be number between 1-10 for most tools, 1-20 for progressive search

**Impact**:
- Higher values = more results but slower response
- Lower values = faster response but less comprehensive

| Tool | Range | Default |
|------|-------|---------|
| full-web-search | 1-10 | 5 |
| get-web-search-summaries | 1-10 | 5 |
| progressive-web-search | 1-20 | 10 |
| cached-web-search | 1-10 | 5 |

**Examples**:
```json
{
  "limit": 3
}
```

---

### includeContent (boolean, optional, default: true)

Whether to fetch full page content or just search snippets.

**Validated**: Boolean or boolean-like string ("true"/"false")

**Impact**:
- `true` = Full extraction (slower, more comprehensive)
- `false` = Snippets only (faster)

| Tool | Required |
|------|----------|
| full-web-search | ❌ Optional |
| cached-web-search | ❌ Optional |

**Examples**:
```json
{
  "includeContent": true
}
```

---

### maxContentLength (number, optional)

Maximum characters for extracted content.

**Validated**: Must be non-negative number

**Special Values**:
- `0` = No limit
- `undefined` or omitted = Use default limit (~5000-50000 chars)

| Tool | Default Behavior |
|------|------------------|
| full-web-search | Auto-optimized |
| get-single-web-page-content | Auto-optimized |
| cached-web-search | Auto-optimized |

**Examples**:
```json
{
  "maxContentLength": 3000
}
```

---

## Tool-Specific Parameters

### url (string, required)

The URL to extract content from.

**Validated**: Must start with `http://` or `https://`

| Tool | Required |
|------|----------|
| get-single-web-page-content | ✅ Yes |
| get-pdf-content | ✅ Yes |
| get-openapi-spec | ✅ Yes |

**Examples**:
```json
{
  "url": "https://example.com/article"
}
```

---

### maxDepth (number, optional)

Maximum directory depth or search stages.

**Validated**: Must be non-negative number

| Tool | Default | Max |
|------|---------|-----|
| get-github-repo-content | 3 | N/A |
| progressive-web-search | 3 | 5 |

**Examples**:
```json
{
  "maxDepth": 2
}
```

---

### maxFiles (number, optional)

Maximum number of files to extract.

**Validated**: Must be non-negative number

| Tool | Default |
|------|---------|
| get-github-repo-content | 50 |

**Examples**:
```json
{
  "maxFiles": 20
}
```

---

### forceRefresh (boolean, optional)

Force refresh cached data.

**Validated**: Boolean or boolean-like string

| Tool | Default |
|------|---------|
| get-openapi-spec | false |

**Examples**:
```json
{
  "forceRefresh": true
}
```

---

## Parameter Validation Rules

### String Parameters

- Must be non-empty
- Maximum length enforced via `MAX_CONTENT_LENGTH` env variable (default: 1000 chars)
- URLs must start with valid protocol (`http://`, `https://`)

### Number Parameters

- Must be numeric (can be passed as string, will be converted)
- Range validation applied per tool requirements
- Negative values rejected

### Boolean Parameters

- Accepts: `true`, `false`, `"true"`, `"false"`
- Case-insensitive for string booleans

---

## Model-Specific Behavior

The server automatically detects model types and adjusts behavior:

### Llama Models (string parameters)
- Detected by string-type parameters
- Applied content length limit of 2000 chars

### Robust Models (numeric parameters)
- Detected by numeric parameters
- No unnecessary content limits applied
- Full responses allowed

**Detection Logic**:
```typescript
// Llama-like: string params like limit="5", includeContent="true"
// Robust: numeric params like limit: 5, includeContent: true
```

---

## Parameter Examples by Tool

### full-web-search Complete Example
```json
{
  "query": "best JavaScript frameworks 2026",
  "limit": 5,
  "includeContent": true,
  "maxContentLength": 5000
}
```

### get-web-search-summaries Complete Example
```json
{
  "query": "TypeScript tutorials for beginners",
  "limit": 3
}
```

### progressive-web-search Complete Example
```json
{
  "query": "fix disk errors Linux",
  "maxDepth": 4,
  "limit": 15
}
```

### get-github-repo-content Complete Example
```json
{
  "url": "https://github.com/microsoft/TypeScript",
  "maxDepth": 3,
  "maxFiles": 50
}
```

---

## Environment Variable Overrides

Some parameters can be set globally via environment variables:

| Parameter | Environment Variable | Default |
|-----------|---------------------|---------|
| maxContentLength | `MAX_CONTENT_LENGTH` | 50000 |
| GitHub maxDepth | `GITHUB_MAX_DEPTH` | 3 |
| GitHub maxFiles | `GITHUB_MAX_FILES` | 50 |

---

## Error Handling

### Common Parameter Errors

| Error | Cause | Solution |
|-------|-------|----------|
| Invalid limit: must be a number between 1 and 10 | limit out of range | Use valid range |
| Invalid url: must be a string with protocol | missing http/https | Add protocol prefix |
| Invalid maxContentLength: must be non-negative | negative value | Use positive number |

### Validation Errors Response

```json
{
  "error": {
    "code": -32602,
    "message": "Invalid parameters: limit must be a number between 1 and 10"
  }
}
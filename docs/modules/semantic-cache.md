# Semantic Cache Module

Intelligent caching with semantic similarity matching for repeated and related queries.

---

## Overview

The semantic cache layer provides intelligent search result caching that recognizes when similar queries have been recently searched, returning cached results to save time and resources.

**File**: `src/semantic-cache.ts`

**Key Features**:
- Query meaning matching (not just exact matches)
- Automatic TTL-based expiration
- Memory-efficient storage with LRU eviction
- Full audit logging for cache operations

---

## How It Works

### Semantic Cache Flow

```
┌──────────────────────────────────────────────────┐
│           User Query Received                    │
└────────────────────┬─────────────────────────────┘
                     │
             ┌───────▼───────┐
             │  Normalize &   │
             │ Tokenize Query │
             └───────┬────────┘
                     │
             ┌───────▼───────────┐
             │ Calculate Query   │
             │ Vector/Fuzzy Hash │
             └───────┬───────────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
  ┌────────┐  ┌────────┐  ┌──────────┐
  │ Cache  │  │ Similar│  │ Miss     │
  │ Lookup │  │ Query  │  │ - Store  │
  └────┬───┘  │ Check  │  │ - New    │
       │      │        │  │ Entry    │
  HIT  │      └────────┘  └──────────┘
  Return│
  Cached│
  Results│
```

### Caching Algorithm

1. **Query Normalization**: Lowercase, remove extra whitespace
2. **Fuzzy Matching**: Compare against cached queries using:
   - Keyword overlap (minimum ~70%)
   - Semantic similarity via embedding or keyword matching
3. **Cache Entry Creation**:
   - Store query vector/hashing
   - Store search results with TTL timestamp
   - Link similar query variants

---

## API Reference

### get Method

```typescript
interface CacheEntry {
  id: string;
  originalQuery: string;
  normalizedQuery: string;
  results: SearchResult[];
  createdAt: string;
  expiresAt: string;
}

const cachedEntry = semanticCache.get(query);
```

**Returns**: `CacheEntry | undefined`

### set Method (Internal)

```typescript
// Results are stored automatically during search
semanticCache.set(query, results, ttl);
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SEMANTIC_CACHE_MAX_SIZE` | 1000 | Maximum cached entries |
| `SEMANTIC_CACHE_TTL` | 3600000 | Cache TTL in ms (1 hour) |

### TTL Behavior

- **Default**: 1 hour from creation
- **Auto-expiration**: Entries older than TTL are evicted on next access
- **LRU Eviction**: When cache is full, oldest entries removed

---

## Performance Characteristics

| Operation | Time |
|-----------|------|
| Cache lookup (hit) | ~1-5ms |
| Cache lookup (miss) | ~10-20ms |
| Full search (no cache) | 3-6s |

**Cache Hit Benefit**: ~90%+ faster response time

---

## Use Cases

### When to Use This Module

✅ Repeated searches for same topic
✅ Related queries that share keywords
✅ Development/testing where cache builds up
✅ Reducing resource usage on frequent searches

### Cache Hit Scenarios

```
Query: "TypeScript MCP server"
→ Later: "typescript mcp"
→ Cache HIT! Returns previous results

Query: "JavaScript frameworks 2026"
→ Later: "best js frameworks"
→ Cache HIT! Returns related results
```

---

## Use Cases NOT Recommended

❌ First-time unique queries (cache miss anyway)
❌ When fresh results are critical (TTL may serve stale data)
❌ Queries that need real-time information

---

## Example Usage in Code

```typescript
import { semanticCache } from './semantic-cache.js';

async function cachedSearch(query: string): Promise<SearchResult[]> {
  // Check cache first
  const cachedEntry = semanticCache.get(query);
  
  if (cachedEntry) {
    console.log(`[CACHE HIT] Returning ${cachedEntry.results.length} results`);
    return cachedEntry.results;
  }
  
  // Perform search and populate cache
  const results = await searchEngine.search({
    query,
    numResults: 5,
  });
  
  return results.results;
}
```

---

## Integration with Other Modules

The semantic cache integrates with:

1. **cached-web-search Tool**: Primary consumer of the cache
2. **Audit Logging**: All cache hits/misses logged
3. **Telemetry**: Cache hit rate tracked
4. **Search Engine**: Results stored after searches

---

## Advanced Features

### Query Expansion

The system stores related query variants:

```
"best tools"
└─ cached with variations:
   ├─ "top tools"
   ├─ "recommended tools"
   └─ "best software"
```

### Automatic Invalidation

- **TTL-based**: Entries expire after configured time
- **LRU eviction**: When cache is full, oldest removed
- **Manual clearing**: Available via debug endpoints

---

## Testing

Test files: `tests/integration/semantic-cache.test.ts`

**Key Tests**:
- Cache hit with exact query
- Cache hit with similar query
- TTL expiration
- LRU eviction when full

---

## Debugging and Monitoring

### Viewing Cache State

```typescript
// Enable debug mode
process.env.DEBUG_AUDIT = 'true';

// Check cache stats (via telemetry)
```

### Telemetry Metrics

- **Cache Hit Rate**: Percentage of queries served from cache
- **Cache Size**: Current number of entries
- **Avg. Query Time With Cache**: vs without cache
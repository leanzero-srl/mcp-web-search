# PDF Extractor Module

Extract and return text content from PDF documents using multiple extraction strategies.

---

## Overview

The PDF extractor provides reliable PDF content extraction with automatic fallback mechanisms for complex or problematic PDFs.

**File**: `src/pdf-extractor.ts`

**Key Features**:
- HTTP-based extraction (fast, direct download)
- Browser-based rendering (fallback for complex PDFs)
- Automatic quality validation before returning results
- Integration with audit logging and telemetry

---

## How It Works

### Extraction Strategy

```
┌─────────────────────────────────────────────────┐
│              PDF URL Provided                   │
└────────────────┬────────────────────────────────┘
                 │
           ┌─────▼─────┐
           │  Check if │
           │   PDF     │
           └─────┬─────┘
                 │
         ┌───────┴────────┐
         ▼                ▼
  ┌──────────┐    ┌─────────────┐
  │  HTTP    │    │ Browser     │
  │ Download │    │ Rendering   │
  │ (Fast)   │    │ (Fallback)  │
  └────┬─────┘    └──────┬──────┘
       │                 │
       └────────┬────────┘
                ▼
      ┌──────────────────┐
      │ Quality Check    │
      │ (min 200 chars)  │
      └────────┬─────────┘
               ▼
     ┌──────────────────┐
     │ Return Content   │
     └──────────────────┘
```

### Two-Stage Extraction Process

**Stage 1: HTTP-Based Extraction**
1. Direct download via axios with text streaming
2. Extract text using PDF libraries
3. Fast and efficient for standard PDFs

**Stage 2: Browser Fallback (if Stage 1 fails)**
1. Launch browser context from pool
2. Render PDF in headless environment
3. Extract rendered content
4. More reliable but slower (~5-10 seconds)

---

## API Reference

### extractPdfContent Method

```typescript
interface PdfExtractionOptions {
  maxContentLength?: number;
}

interface PdfExtractionResult {
  text: string;
  extractionMethod: 'http' | 'browser';
  pageCount?: number;
  fileSize?: number;
}
```

**Usage**:
```typescript
import { pdfExtractor } from './pdf-extractor.js';

const result = await pdfExtractor.extractPdfContent(
  'https://example.com/document.pdf',
  { maxContentLength: 5000 }
);
console.log(result.text); // Extracted content
console.log(result.extractionMethod); // 'http' or 'browser'
```

### truncateText Method

```typescript
const truncated = pdfExtractor.truncateText(
  longText,
  maxLength
);
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEFAULT_TIMEOUT` | 6000 | Request timeout in ms |

### Content Limits

- **Minimum Content Length**: 200 characters (before validation)
- **Maximum Content Length**: Configurable via `MAX_CONTENT_LENGTH` env var
- **Default Output Limit**: ~50000 characters

---

## Performance Characteristics

| Extraction Method | Time | Reliability |
|-------------------|------|-------------|
| HTTP Download | 1-3 seconds | High for standard PDFs |
| Browser Render | 5-10 seconds | High for complex PDFs |

**Note**: Browser fallback is only used when HTTP extraction fails.

---

## Use Cases

### When to Use This Module

✅ Extract text from research papers (.pdf)
✅ Read documentation available as PDF
✅ Get content from academic sources and technical reports

### When NOT to Use

❌ For HTML web pages (use `get-single-web-page-content`)
❌ For PDF URLs that don't exist
❌ For very large PDFs without maxContentLength limit

---

## Example Usage in Code

```typescript
import { pdfExtractor } from './pdf-extractor.js';

async function processPdf(url: string): Promise<string> {
  const result = await pdfExtractor.extractPdfContent(url);
  
  if (!result.text || result.text.length < 200) {
    throw new Error('PDF extraction returned insufficient content');
  }
  
  return pdfExtractor.truncateText(result.text, 5000);
}
```

---

## Integration with Other Modules

The PDF extractor is fully integrated with:

1. **Audit Logging**: All extractions logged with full context
2. **Telemetry**: Extraction time and success rate tracked
3. **Error Handling**: Proper MCP error codes returned

---

## Error Handling

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| Network timeout | Slow/unstable network | Increase DEFAULT_TIMEOUT |
| Content too short | Scanned/empty PDF | Use browser fallback manually |
| Access denied (403) | Required auth | Provide credentials |

---

## Testing

Test files: `tests/integration/pdf-integration.test.ts`

**Key Tests**:
- HTTP extraction success
- Browser fallback on failure
- Quality validation
- Content truncation

---

## Advanced Configuration

### Custom Timeout

```typescript
const result = await pdfExtractor.extractPdfContent(url, {
  maxContentLength: 10000,
});
```

### Force Browser Extraction

If you know HTTP will fail (e.g., for scanned PDFs):

```typescript
// For complex PDFs, browser extraction is more reliable
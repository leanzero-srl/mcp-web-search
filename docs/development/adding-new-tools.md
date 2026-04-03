# Adding New MCP Tools - Developer Guide

How to add new tools to the Web Search MCP Server.

---

## Overview

This guide explains how to add a new MCP tool to the server. All tools are defined in `src/index.ts` and follow a consistent pattern for validation, execution, and response formatting.

---

## Tool Anatomy

Every MCP tool consists of:

1. **Tool Registration** - The `server.tool()` call
2. **Input Schema** - Zod schema defining valid parameters
3. **Handler Function** - Async function that executes the tool logic
4. **Response Formatting** - Returns data in MCP format

### Minimal Tool Template

```typescript
this.server.tool(
  'tool-name',
  'Tool description for AI models',
  {
    // Parameter definitions with Zod schemas
  },
  async (args: unknown) => {
    try {
      // Validate and process arguments
      // Execute tool logic
      // Format response
    } catch (error) {
      // Handle errors
    }
  }
);
```

---

## Step-by-Step: Creating a New Tool

### Step 1: Choose the Tool Name

Use kebab-case naming convention:

| Good | Bad |
|------|-----|
| `get-web-content` | `GetWebContent` |
| `fetch-page-data` | `FetchPageData` |
| `extract-metadata` | `ExtractMetadata` |

**Rules**:
- Use `get-`, `fetch-`, or `extract-` prefix for retrieval tools
- Be descriptive and concise
- Avoid generic names like `search`

### Step 2: Define Input Schema with Zod

```typescript
import { z } from 'zod';

// Example: Tool to extract title from a URL
{
  url: z.string().url().describe('The URL to extract title from'),
  maxContentLength: z.union([z.number(), z.string()]).transform((val) => {
    const num = typeof val === 'string' ? parseInt(val, 10) : val;
    if (isNaN(num) || num < 0) {
      throw new Error('Invalid maxContentLength');
    }
    return num;
  }).optional().describe('Maximum content length'),
}
```

**Zod Validation Tips**:
- Use `z.string()` for text inputs
- Use `z.number()` or `z.union([z.number(), z.string()])` for numbers (handles string-to-number conversion)
- Add `.default(value)` for optional parameters
- Always describe parameters with `.describe()`
- Transform values to handle type coercion

### Step 3: Implement the Handler Function

```typescript
async (args: unknown) => {
  // 1. Validate arguments
  if (typeof args !== 'object' || args === null) {
    throw new Error('Invalid arguments');
  }
  
  const obj = args as Record<string, unknown>;
  
  // 2. Extract and validate required parameters
  if (!obj.url || typeof obj.url !== 'string') {
    throw new Error('url is required and must be a string');
  }
  
  // 3. Extract optional parameters with defaults
  let maxContentLength: number | undefined;
  if (obj.maxContentLength !== undefined) {
    const val = typeof obj.maxContentLength === 'string' 
      ? parseInt(obj.maxContentLength, 10)
      : obj.maxContentLength;
    maxContentLength = isNaN(val) ? undefined : val;
  }
  
  // 4. Execute tool logic
  const title = await this.extractTitle(obj.url);
  
  // 5. Format response as MCP text content
  let responseText = `**Page Title:** ${title}\n`;
  responseText += `**URL:** ${obj.url}`;
  
  return {
    content: [
      {
        type: 'text' as const,
        text: responseText,
      },
    ],
  };
}
```

### Step 4: Error Handling

All tools must handle errors consistently:

```typescript
try {
  // Tool logic here
} catch (error) {
  this.handleError(error, 'tool-name');
}

// The handleError method is already defined in the class:
private handleError(error: unknown, toolName: string): never {
  console.error(`[MCP] Error in ${toolName}:`, error);
  
  if (error instanceof McpError) {
    throw error;
  }
  
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    
    // Map common errors to appropriate MCP codes
    if (message.includes('invalid')) {
      throw new McpError(-32602, `Invalid parameters: ${error.message}`);
    }
    if (message.includes('timeout')) {
      throw new McpError(-32001, `Request timeout: ${error.message}`);
    }
    
    // Default to internal error
    throw new McpError(-32603, `Internal server error: ${error.message}`);
  }
  
  throw new McpError(-32603, 'Unknown error occurred');
}
```

---

## Complete Example: New Tool

Let's create a tool that fetches and returns the character count of a web page:

```typescript
// In src/index.ts, add after existing tools:

this.server.tool(
  'get-page-character-count',
  'Extract the character count from a web page URL. Useful for estimating content size before full extraction.',
  {
    url: z.string().url().describe('The URL of the web page to analyze'),
    maxContentLength: z.union([z.number(), z.string()]).transform((val) => {
      const num = typeof val === 'string' ? parseInt(val, 10) : val;
      if (isNaN(num) || num < 0) {
        throw new Error('Invalid maxContentLength');
      }
      return num;
    }).optional().describe('Maximum content length to analyze'),
  },
  async (args: unknown) => {
    console.log(`[MCP] Tool call received: get-page-character-count`);
    
    try {
      // Validate arguments
      if (typeof args !== 'object' || args === null) {
        throw new Error('Invalid arguments');
      }
      
      const obj = args as Record<string, unknown>;
      
      if (!obj.url || typeof obj.url !== 'string') {
        throw new Error('url is required and must be a string');
      }
      
      // Extract optional parameters
      let maxContentLength: number | undefined;
      if (obj.maxContentLength !== undefined) {
        const val = typeof obj.maxContentLength === 'string'
          ? parseInt(obj.maxContentLength, 10)
          : obj.maxContentLength;
        maxContentLength = isNaN(val) ? undefined : val;
      }
      
      // Fetch and extract content
      console.log(`[MCP] Extracting content from: ${obj.url}`);
      
      const content = await this.contentExtractor.extractContent({
        url: obj.url,
        maxContentLength,
      });
      
      const charCount = content.length;
      
      console.log(`[MCP] Character count extracted: ${charCount}`);
      
      // Format response
      let responseText = `**Character Count Analysis**\n\n`;
      responseText += `**URL:** ${obj.url}\n`;
      responseText += `**Total Characters:** ${charCount.toLocaleString()}\n`;
      
      if (maxContentLength && content.length > maxContentLength) {
        responseText += `**Truncated at:** ${maxContentLength} characters\n`;
      }
      
      return {
        content: [
          {
            type: 'text' as const,
            text: responseText,
          },
        ],
      };
    } catch (error) {
      this.handleError(error, 'get-page-character-count');
    }
  }
);
```

---

## Integration Points

When adding a new tool, consider:

### 1. Enterprise Guardrails

The `handleError` method already handles rate limiting and validation. Ensure your tool works with these:

- **Rate Limiting**: Automatic via session rate limiter
- **Input Validation**: Zod schemas handle this automatically
- **Output Limiting**: Handled in response formatting

### 2. Observability

All tool calls are logged automatically in `handleError`. Make sure to log:
```typescript
console.log(`[MCP] Tool call received: tool-name`);
console.log(`[MCP] Processing completed, result: ${result}`);
```

### 3. Telemetry

The observability module tracks tool success/failure rates. Ensure errors are properly thrown (not caught silently).

---

## Testing the New Tool

### Integration Test Template

Create a test in `tests/integration/`:

```typescript
// tests/integration/new-tool.test.ts
import { expect, test } from 'vitest';
import { spawnMcpServer, callTool } from './utils.js';

test('new tool should return character count', async () => {
  const server = await spawnMcpServer();
  
  try {
    const result = await callTool(server, 'get-page-character-count', {
      url: 'https://example.com',
      maxContentLength: 1000,
    });
    
    expect(result).toHaveProperty('content');
    expect(Array.isArray(result.content)).toBe(true);
    
    // Verify the response contains character count
    const text = result.content[0].text;
    expect(text).toContain('Character Count Analysis');
    expect(text).toContain('Total Characters:');
  } finally {
    await server.close();
  }
});
```

### Run Tests

```bash
npm run test:integration -- tests/integration/new-tool.test.ts
```

---

## Documentation Requirements

After adding a tool, document it:

1. **Add to Tool Reference**: Update `docs/tools/tool-reference.md`
2. **Update Parameters Guide**: Add parameter documentation to `docs/tools/parameters.md`
3. **Update README**: Mention new tool in overview

### Example Documentation Entry

```markdown
### 9. get-page-character-count

**Extract character count from web page**

**Description**: Extract and return the character count of a web page's content.

**When to Use**: When you need to estimate content size without full extraction.

**Input Schema**:
```json
{
  "url": {
    "type": "string",
    "format": "uri"
  },
  "maxContentLength": {
    "type": "number",
    "optional": true
  }
}
```
```

---

## Common Patterns

### Parameter Type Handling

Always handle both number and string types for robustness:

```typescript
limit: z.union([z.number(), z.string()]).transform((val) => {
  const num = typeof val === 'string' ? parseInt(val, 10) : val;
  if (isNaN(num)) throw new Error('Invalid limit');
  return num;
}).default(5)
```

### Boolean Handling

```typescript
includeContent: z.union([z.boolean(), z.string()]).transform((val) => {
  if (typeof val === 'string') {
    return val.toLowerCase() === 'true';
  }
  return Boolean(val);
}).default(true)
```

---

## Checklist for Tool Addition

- [ ] Tool name follows naming convention
- [ ] Zod schemas defined with proper validation
- [ ] Handler function validates arguments
- [ ] Error handling uses `handleError` method
- [ ] Response formatted as MCP text content
- [ ] Integration test created
- [ ] Documentation updated in docs/tools/
- [ ] Tool name added to README overview

---

## Next Steps

1. Review existing tool implementations in `src/index.ts`
2. Check integration tests for examples
3. Refer to `docs/architecture/overview.md` for system design context
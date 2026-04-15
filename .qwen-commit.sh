#!/bin/bash

cd /Users/mihaiperdum/Projects/mcp-web-search-upd/mcp-web-search

# Stage the modified file
git add src/openapi-extractor.ts

# Commit with message
git commit -m "fix: Add URL validation before fetching in OpenAPI extractor

- Validates URL format using new URL() constructor
- Returns early with clear error message for invalid URLs
- Prevents network errors from malformed URLs"

# Push to remote
git push origin main

# Development Documentation

Everything you need to know about developing the Web Search MCP Server.

---

## Quick Start for Developers

### Prerequisites

- Node.js 18.0.0 or higher
- npm 8.0.0 or higher
- git

### Setup

```bash
# Clone repository
git clone https://github.com/mrkrsl/web-search-mcp.git
cd web-search-mcp

# Install dependencies
npm install

# Install Playwright browsers
npx playwright install

# Build the project
npm run build

# Run tests
npm test
```

---

## Documentation Structure

| Document | Purpose |
|----------|---------|
| [Setup Guide](./setup.md) | Development environment setup |
| [Adding New Tools](./adding-new-tools.md) | How to create new MCP tools |
| [Enterprise Guardrails](./enterprise-guardrails.md) | Rate limiting and security |

---

## Adding a New Tool

1. **Read** [`docs/development/adding-new-tools.md`](./adding-new-tools.md)
2. **Review** existing tool implementations in `src/index.ts`
3. **Write** integration tests in `tests/integration/`
4. **Document** the new tool in `docs/tools/`

---

## Testing

```bash
npm test                    # Run all unit and integration tests
npm run test:integration   # Run only integration tests
npm run lint               # Check code quality
npm run format             # Format code with Prettier
```

---

## Configuration for Development

Create a `.env` file in the project root:

```bash
# Enable debug logging
DEBUG_AUDIT=true

# Visible browser for debugging
BROWSER_HEADLESS=false
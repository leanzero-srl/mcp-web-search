#!/usr/bin/env node

// Install the stdio-safe console shim BEFORE any other module is evaluated.
// Our own module-level singletons and some transitive deps print to console at
// module-load time; without this redirect they corrupt the MCP JSON-RPC frame
// stream on stdout. It MUST be a side-effect import listed first (imports are
// hoisted, so a plain call statement here would run after server.js loaded).
import './stdio-shim.js';

import { WebSearchMCPServer } from './server.js';

const server = new WebSearchMCPServer();
server.run().catch((error: unknown) => {
  if (error instanceof Error) {
    process.stderr.write(`[fatal] Server error: ${error.message}\n`);
  } else {
    process.stderr.write(`[fatal] Server error: ${String(error)}\n`);
  }
  process.exit(1);
});

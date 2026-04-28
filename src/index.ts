#!/usr/bin/env node

// Install the stdio-safe console shim BEFORE any other import. Some
// transitive deps (cheerio, playwright internals, undici) print to console at
// module-load time; without this redirect they would corrupt the MCP JSON-RPC
// frame stream on stdout.
import { installStdioSafeConsoleShim } from './logger.js';
installStdioSafeConsoleShim();

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

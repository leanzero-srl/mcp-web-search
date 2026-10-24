/**
 * Side-effect module: installs the stdio-safe console shim the moment it is
 * evaluated. index.ts imports it FIRST.
 *
 * Why a separate module: ES `import` declarations are hoisted and evaluated
 * before any statement in the importing module runs. Calling
 * `installStdioSafeConsoleShim()` as a statement in index.ts therefore ran
 * AFTER server.js and its whole import graph had been evaluated, and the
 * module-level singletons (BrowserPool, SemanticCache, RequestDeduplicator,
 * CrawlCache) had already printed four plain-text lines to stdout — which
 * every stdio MCP client reads as corrupt JSON-RPC frames ("MCP Transport
 * Error"). Imports are evaluated in source order, so importing this module
 * first runs the shim before anything else in the graph.
 * Guarded by tests/integration/stdio-clean-stdout.test.ts.
 */
import { installStdioSafeConsoleShim } from './logger.js';

installStdioSafeConsoleShim();

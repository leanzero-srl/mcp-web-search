/**
 * Per-request context carried through the async call tree via AsyncLocalStorage.
 *
 * Why this exists: the HTTP transport builds a fresh `McpServer` per request but
 * the 11 tools close over a single, process-shared `SearchEngine` (see
 * `server.ts` / `http-server.ts`). To let each caller bring their OWN Serper key
 * without threading it through every tool schema (which would also leak the key
 * into tool-call logs/transcripts), the HTTP layer stashes the key here for the
 * duration of the request and `search-engine.ts` reads it back at call time,
 * falling back to `process.env.SERPER_API_KEY`.
 *
 * The stdio transport never populates the store, so it transparently falls back
 * to the process env (the user's `mcp.json` `env` block) — behaviour unchanged.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestCtx {
  /** Per-request Serper API key supplied by the caller (header or query param). */
  serperKey?: string;
  /** Per-request GitHub token supplied by the caller (header or query param). */
  githubToken?: string;
  /** Per-request output sub-dir (X-Output-Dir header / ?output_dir), sandboxed
   *  under the server output base by getOutputRoot() in server.ts. */
  outputDir?: string;
}

export const requestContext = new AsyncLocalStorage<RequestCtx>();

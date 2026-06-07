/**
 * MCP client detection.
 *
 * After the `initialize` handshake the server learns the client's reported
 * `name` and `version`. We use that to gate one specific behavior pattern:
 * tools that *write content to disk and return only a file path* are useful
 * to agentic clients (Cline / Claude Desktop / Roo Code) which run a sibling
 * filesystem MCP and can read the file. The same response is a dead end for
 * clients without a filesystem tool — most notably LM Studio in chat mode,
 * which is our primary downstream consumer via the
 * Forge → LM Studio → MCP chain.
 *
 * `isAgenticClient()` returns `true` only when the client identifies as one
 * of the known agentic frontends. Default-deny on unknown names: safer to
 * return content inline and waste some context budget than to hand back a
 * path the LLM cannot open.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from './logger.js';

/**
 * Whitelist of clients that have a sibling filesystem MCP available, so the
 * "save to disk + return path" pattern actually delivers content. Match is
 * case-insensitive against the leading prefix of `getClientVersion().name`.
 *
 * Add new entries here when a new agentic frontend integrates this server.
 * Always whitelist conservatively — false positives downgrade UX (LM Studio
 * users would silently get unreachable file paths).
 */
const AGENTIC_NAMES = [
  'claude-ai',
  'claude.ai',
  'claude-desktop',
  'claude desktop',
  'cline',
  'roo code',
  'roo-cline',
  'continue',
];

/**
 * Pure helper. Returns `true` if the given client name (as reported in
 * `initialize.params.clientInfo.name`) matches the agentic whitelist. Exported
 * so tests can exercise the production matching rule directly instead of
 * duplicating it.
 */
export function classifyClientNameAsAgentic(name: string): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return AGENTIC_NAMES.some((n) => lower.startsWith(n));
}

interface ClientInfo {
  name: string;
  version: string;
  isAgentic: boolean;
}

let cached: ClientInfo | null = null;

/**
 * Wires the detection callback onto an `McpServer`. Call once during boot,
 * before `server.connect(transport)`. Idempotent.
 */
export function attachClientDetect(server: McpServer): void {
  // The underlying low-level Server exposes `oninitialized`, fired AFTER the
  // client sends `notifications/initialized` (i.e. after `initialize` has
  // completed and `getClientVersion()` is populated).
  server.server.oninitialized = () => {
    const impl = server.server.getClientVersion();
    if (!impl) {
      logger.warn('client-detect: getClientVersion() returned undefined; defaulting to non-agent', {});
      cached = { name: 'unknown', version: '0', isAgentic: false };
      return;
    }
    const name = (impl.name || 'unknown').toString();
    const version = (impl.version || '0').toString();
    const isAgentic = classifyClientNameAsAgentic(name);
    cached = { name, version, isAgentic };
    logger.info('client-detect: client identified', { name, version, isAgentic });
  };
}

/**
 * Returns the cached client info. `null` until `notifications/initialized`
 * has arrived. In practice tool handlers run after init, so callers can
 * normally assume non-null — but `isAgenticClient()` is the safer entry
 * point for branching logic.
 */
export function getClientInfo(): ClientInfo | null {
  return cached;
}

/**
 * `true` only when the client matches the agentic whitelist. Defaults to
 * `false` until the init handshake completes (LM Studio behavior is the safe
 * fallback for everything that branches on this).
 */
export function isAgenticClient(): boolean {
  return cached?.isAgentic === true;
}

/**
 * Coding/agentic frontends that maintain long-term MEMORY and run a tool loop —
 * i.e. clients that can actually act on a "save a memory" nudge. Distinct from
 * AGENTIC_NAMES (which is about a sibling filesystem). Substring match.
 */
const MEMORY_CAPABLE_NAMES = [
  'claude-code', 'claude code', 'cursor', 'cline', 'roo', 'windsurf', 'aider',
  'continue', 'opencode', 'open-code', 'qwen', 'hermes', 'codex', 'zed', 'cody',
  'goose', 'kilo', 'amp', 'crush',
];

/**
 * Whether the connecting client can persist long-term memories (so it's worth
 * nudging it to save "how to search/use this tool better" notes). Chat UIs like
 * LM Studio return false. `MCP_CLIENT_MEMORY` env forces it on/off.
 *
 * On the stateless HTTP server clientInfo is unknown at tool time, so this is
 * false unless the operator sets the env — which is exactly right (LM Studio
 * over the Funnel should get no nudge).
 */
export function clientCanPersistMemory(): boolean {
  const v = (process.env.MCP_CLIENT_MEMORY || '').toLowerCase();
  if (/^(1|true|yes|on)$/.test(v)) return true;
  if (/^(0|false|no|off)$/.test(v)) return false;
  const name = (cached?.name || '').toLowerCase();
  return MEMORY_CAPABLE_NAMES.some((n) => name.includes(n));
}

/**
 * Test-only: force a specific client info value. Used by smoke tests that
 * drive an `initialize` request through the in-process server.
 * @internal
 */
export function __setClientInfoForTesting(info: ClientInfo | null): void {
  cached = info;
}

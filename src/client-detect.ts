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
    const lower = name.toLowerCase();
    const isAgentic = AGENTIC_NAMES.some((n) => lower.startsWith(n));
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
 * Test-only: force a specific client info value. Used by smoke tests that
 * drive an `initialize` request through the in-process server.
 * @internal
 */
export function __setClientInfoForTesting(info: ClientInfo | null): void {
  cached = info;
}

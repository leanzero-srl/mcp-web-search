#!/usr/bin/env bash
#
# Drive the built MCP server with a chosen `clientInfo.name` and run one
# tool call. Useful for verifying client-aware branching (the same call
# returns different shapes for "Cline" vs "lm-studio") and for sanity
# checking any tool end-to-end without an MCP client.
#
# Usage:
#   scripts/dev/mcp-call-as.sh <clientName> <toolName> <toolArgsJson>
#
# Example:
#   scripts/dev/mcp-call-as.sh lm-studio get-openapi-spec \
#     '{"url":"https://petstore.swagger.io/v2/swagger.json"}'
#
# Returns the raw JSON-RPC response body for the tool call on stdout. Pipe
# through `jq -r '.result.content[0].text'` to get just the response text,
# or `jq '.result.isError'` to check the error flag.
#
# The script always boots a fresh server, so cold-start latency adds ~2s.
# `dist/index.js` must exist (run `npm run build` first).

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <clientName> <toolName> <toolArgsJson>" >&2
  exit 2
fi

CLIENT_NAME="$1"
TOOL_NAME="$2"
TOOL_ARGS="$3"

# Resolve repo root regardless of where the user invokes the script from.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVER="$REPO_ROOT/dist/index.js"

if [ ! -f "$SERVER" ]; then
  echo "error: $SERVER not found. Run 'npm run build' first." >&2
  exit 1
fi

(
  printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"%s","version":"dev-smoke"}}}\n' "$CLIENT_NAME"
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"%s","arguments":%s}}\n' "$TOOL_NAME" "$TOOL_ARGS"
  # Hold the pipe open long enough for the tool to finish. Tools are capped at
  # 20s wall-clock; allow a bit more for cold-start + network.
  sleep "${MCP_CALL_AS_SLEEP:-25}"
) | node "$SERVER" 2>/dev/null | tail -1

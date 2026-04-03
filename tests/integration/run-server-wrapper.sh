#!/bin/bash
# This wrapper runs node with all output redirected to stderr
# This prevents any stdout output from corrupting the MCP JSON-RPC protocol
# We redirect stdout (fd 1) to stderr (fd 2)

exec node "$@" >&2

#!/bin/bash
# Wrapper script to spawn the MCP server with stdout redirected to stderr for debug output
# This prevents console.log statements from corrupting the MCP protocol JSON stream

# Use node --require to preload a module that redirects console.log to stderr
exec node --require ./tests/integration/console-wrapper.js "$@"
// Redirect all console output methods to stderr to prevent MCP protocol corruption
// This must run before any other imports in tests

function redirectConsoleMethod(method: string) {
  const original = console[method];
  if (typeof original === 'function') {
    console[method] = (...args) => {
      const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)).join(' ');
      process.stderr.write(`[${method.toUpperCase()}] ${message}\n`);
    };
  }
}

// Redirect all common console methods
redirectConsoleMethod('log');
redirectConsoleMethod('warn');
redirectConsoleMethod('error');
redirectConsoleMethod('info');
redirectConsoleMethod('debug');
redirectConsoleMethod('trace');

// Also redirect process.stdout.write to prevent any direct stdout writes from corrupting MCP protocol
const originalStdoutWrite = process.stdout.write;
process.stdout.write = ((chunk: string | Buffer, encoding?: BufferEncoding | null) => {
  const text = typeof chunk === 'string' ? chunk : chunk.toString();
  // Only allow output that looks like MCP JSON-RPC (starts with { or [)
  if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
    return originalStdoutWrite.call(process.stdout, chunk, encoding);
  }
  // Everything else goes to stderr
  process.stderr.write(`[STDOUT_REDIRECTED] ${text}`);
  return true;
}) as typeof process.stdout.write;

// Also suppress Playwright's installation banner by hooking into stderr directly
const originalStderrWrite = process.stderr.write;
process.stderr.write = ((chunk: string | Buffer) => {
  const text = typeof chunk === 'string' ? chunk : chunk.toString();
  if (text.includes('Looks like Playwright') || text.includes('<3 Playwright')) {
    return true; // Suppress by not passing through
  }
  return originalStderrWrite.call(process.stderr, chunk);
}) as typeof process.stderr.write;

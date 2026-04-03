// Console wrapper to redirect all console output methods to stderr
// This is loaded via node --require before any other code runs

function redirectConsoleMethod(method) {
  const original = console[method];
  if (typeof original === 'function') {
    console[method] = function(...args) {
      // Format the message
      const message = args.map(arg => {
        if (arg instanceof Error) {
          return arg.message + (arg.stack ? '\n' + arg.stack : '');
        } else if (typeof arg === 'object') {
          return JSON.stringify(arg, null, 2);
        } else {
          return String(arg);
        }
      }).join(' ');
      
      // Write to stderr with method prefix
      process.stderr.write(`[${method.toUpperCase()}] ${message}\n`);
    };
  }
}

// Redirect all common console methods to stderr
redirectConsoleMethod('log');
redirectConsoleMethod('warn');
redirectConsoleMethod('error');
redirectConsoleMethod('info');
redirectConsoleMethod('debug');
redirectConsoleMethod('trace');

// Also intercept process.stdout.write for direct writes
const originalStdoutWrite = process.stdout.write;
process.stdout.write = function(chunk, encoding, callback) {
  const text = typeof chunk === 'string' ? chunk : chunk.toString();
  
  // Check if this looks like a console output message (has [LOG], [WARN], etc.)
  if (/^\[(LOG|WARN|ERROR|DEBUG|TRACE)\]/.test(text)) {
    return originalStdoutWrite.call(process.stderr, chunk, encoding, callback);
  }
  
  // For anything else, write to stderr (this catches direct console.log that might bypass our wrapper)
  // But we need to allow JSON MCP protocol messages through
  // A simple heuristic: JSON objects start with { or [
  if (!text.trim().startsWith('{') && !text.trim().startsWith('[')) {
    return originalStdoutWrite.call(process.stderr, chunk, encoding, callback);
  }
  
  // Allow JSON through (MCP protocol messages)
  return originalStdoutWrite.call(process.stdout, chunk, encoding, callback);
};
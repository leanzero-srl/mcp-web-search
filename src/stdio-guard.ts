/**
 * Keep the process alive when its log sink fails.
 *
 * Under launchd, stdout and stderr are a log file. When that disk is full a
 * write fails with ENOSPC; Node turns the failure into an 'error' event on
 * process.stdout / process.stderr, and an 'error' event with no listener
 * throws, which killed the server (exit 1) and launchd restarted it into a
 * loop. The same happens with EPIPE when a stdio client goes away.
 *
 * This installs one listener per stream that drops the line on a known
 * "the sink is unwritable" error. The stream is not destroyed
 * (stdout/stderr are SyncWriteStreams on a file), so logging resumes on its
 * own once space is freed. Any OTHER error code is re-thrown, so a real bug
 * still surfaces exactly as before: this is not a blanket swallow.
 *
 * Idempotent; imported first by both entry points (index.ts, http-server.ts).
 */

/** Errors that mean "the log sink cannot take this write", nothing more. */
export const SINK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOSPC', // disk full
  'EDQUOT', // quota exceeded
  'EFBIG', // file too large
  'EPIPE', // reader went away (stdio client closed)
  'EIO', // terminal/device gone
  'EAGAIN', // non-blocking sink momentarily full
  'ECONNRESET',
  'ERR_STREAM_DESTROYED',
]);

let dropped = 0;
let installed = false;

/**
 * How many logger lines were dropped because the sink failed. Counted from
 * each write's callback (logger.ts): a Writable emits its 'error' EVENT only
 * once, so the event alone cannot count.
 */
export function droppedLogLines(): number {
  return dropped;
}

/** True when `err` is a log-sink failure we may drop. */
export function isSinkError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && SINK_ERROR_CODES.has(code);
}

/** Count one dropped logger line. */
export function noteDroppedWrite(): void {
  dropped++;
}

export function installStdioErrorGuards(): void {
  if (installed) return;
  installed = true;
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (err: unknown) => {
      if (isSinkError(err)) return;
      throw err;
    });
  }
}

installStdioErrorGuards();

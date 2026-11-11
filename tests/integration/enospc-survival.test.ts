/**
 * Disk full must not take the hosted server down.
 *
 * Under launchd the server's stdout/stderr are a log file. When the disk that
 * holds that file (or DATA_DIR) is full, a log write fails with ENOSPC. Before
 * the fix that killed the process (an 'error' event on process.stderr with no
 * listener, and an async admin/provision route whose tenants.json write
 * rejected with nothing to catch it), and launchd restarted it into a loop.
 *
 * This test runs the REAL HTTP entry point in a child process with its log and
 * DATA_DIR on a genuinely full 4 MB disk image (hdiutil, macOS only), drives
 * the paths that write (startup log, refused log, provisioning, admin create,
 * usage flush), checks the process is still alive and serving, that a save
 * which runs out of space part-way leaves no temp file, then frees the space
 * and checks that writes work again.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(__dirname, '..', '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const ENTRY = path.join(REPO, 'src', 'http-server.ts');

function hasHdiutil(): boolean {
  if (process.platform !== 'darwin') return false;
  try { execFileSync('/usr/bin/hdiutil', ['help'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const RUN = hasHdiutil() && fs.existsSync(TSX);

let workDir = '';
let image = '';
let mnt = '';
let logFile = '';
let filler = '';
let child: ChildProcess | null = null;
let port = 0;
let exitInfo: { code: number | null; signal: string | null } | null = null;

const PROVISION_SECRET = 'enospc-test-provision-secret-0123456789';
const ADMIN_TOKEN = 'enospc-test-admin-token-0123456789';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

/** Write zeros until the volume refuses with ENOSPC (the disk is then really full). */
function fillDisk(file: string): void {
  const fd = fs.openSync(file, 'w');
  try {
    for (const size of [256 * 1024, 4096, 512, 1]) {
      const buf = Buffer.alloc(size);
      for (;;) {
        try { fs.writeSync(fd, buf); } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOSPC') break;
          throw e;
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function assertDiskFull(): void {
  let code: string | undefined;
  try { fs.appendFileSync(logFile, 'probe-should-not-fit\n'); } catch (e) { code = (e as NodeJS.ErrnoException).code; }
  expect(code, 'the test volume must really be full').toBe('ENOSPC');
}

async function get(p: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${p}`, { ...init, signal: AbortSignal.timeout(10_000) });
}

const alive = (): boolean => !!child && child.exitCode === null && child.signalCode === null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  if (!RUN) return;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ws-enospc-'));
  image = path.join(workDir, 'full.dmg');
  mnt = path.join(workDir, 'mnt');
  fs.mkdirSync(mnt);
  execFileSync('/usr/bin/hdiutil', ['create', '-size', '4m', '-fs', 'HFS+', '-volname', 'wsenospc', '-layout', 'NONE', image], { stdio: 'ignore' });
  execFileSync('/usr/bin/hdiutil', ['attach', '-nobrowse', '-mountpoint', mnt, image], { stdio: 'ignore' });

  const dataDir = path.join(mnt, 'data');
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'usage'), { recursive: true });
  // A tenants.json bigger than the space freed later, so a save writes a
  // PARTIAL temp file before ENOSPC (the leftover-temp-file case).
  const padded: Record<string, unknown> = {};
  for (let i = 0; i < 300; i++) {
    padded[`pad-${i}`] = {
      displayName: `padding-${i}-${'p'.repeat(360)}`, class: 'public', bearerHash: '',
      expiringHashes: [], createdAt: new Date(0).toISOString(), lastUsedAt: null,
    };
  }
  fs.writeFileSync(path.join(dataDir, 'tenants.json'), JSON.stringify(padded, null, 2));
  logFile = path.join(mnt, 'server.log');
  fs.writeFileSync(logFile, '');
  filler = path.join(mnt, 'filler.bin');
  fillDisk(filler);
  assertDiskFull();

  port = await freePort();
  const logFd = fs.openSync(logFile, 'a');
  child = spawn(TSX, [ENTRY], {
    cwd: REPO,
    stdio: ['ignore', logFd, logFd],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PORT: String(port),
      DATA_DIR: dataDir,
      LOG_LEVEL: 'debug',
      USAGE_FLUSH_MS: '100',
      PROVISION_SECRET,
      MCP_WEB_SEARCH_ADMIN_TOKEN: ADMIN_TOKEN,
    },
  });
  fs.closeSync(logFd);
  child.on('exit', (code, signal) => { exitInfo = { code, signal }; });

  // Wait for the server to answer (or to die).
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && alive()) {
    try { if ((await get('/healthz')).ok) break; } catch { /* not up yet */ }
    await sleep(250);
  }
}, 90_000);

afterAll(async () => {
  if (!RUN) return;
  if (child && alive()) {
    child.kill('SIGKILL');
    await sleep(300);
  }
  try { execFileSync('/usr/bin/hdiutil', ['detach', mnt, '-force'], { stdio: 'ignore' }); } catch { /* already gone */ }
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(!RUN)('disk full (ENOSPC) on the log and data volume', () => {
  it('boots and serves /healthz while every log write fails', async () => {
    expect(alive(), `server died on a full disk: ${JSON.stringify(exitInfo)}`).toBe(true);
    const res = await get('/healthz');
    expect(res.status).toBe(200);
  });

  it('survives the write paths: refused log, provisioning, admin create, usage', async () => {
    assertDiskFull();
    // 401 -> refused.jsonl append + logger lines.
    const unauth = await get('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauth.status).toBe(401);
    expect((await get('/.env')).status).toBe(404);

    // tenants.json cannot be written: the request fails cleanly, the process stays up.
    const prov = await get('/v1/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PROVISION_SECRET}` },
      body: JSON.stringify({ label: 'enospc-test' }),
    });
    expect(prov.status).toBe(500);
    const admin = await get('/v1/admin/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ displayName: 'enospc-admin' }),
    });
    expect(admin.status).toBe(500);
    const revoke = await get('/v1/provision/does-not-exist', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${PROVISION_SECRET}` },
    });
    expect([404, 500]).toContain(revoke.status);

    // Let async writes (usage flush, refused log, stderr) settle and fail.
    await sleep(1500);
    expect(alive(), `server died on a full disk: ${JSON.stringify(exitInfo)}`).toBe(true);
    expect((await get('/healthz')).status).toBe(200);
  });

  it('a save that runs out of space part-way leaves no temp file behind', async () => {
    // Free 64 KB: less than the ~120 KB tenants.json, so the temp file is
    // partly written before ENOSPC.
    const size = fs.statSync(filler).size;
    fs.truncateSync(filler, size - 64 * 1024);
    const st = fs.statfsSync(mnt);
    expect(st.bavail * st.bsize, 'free space before the save').toBeGreaterThan(16 * 1024);
    const prov = await get('/v1/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PROVISION_SECRET}` },
      body: JSON.stringify({ label: 'enospc-partial' }),
    });
    expect(prov.status).toBe(500);
    await sleep(500);
    expect(alive()).toBe(true);
    const leftovers = fs.readdirSync(path.join(mnt, 'data')).filter((n) => n.includes('.tmp.'))
      .concat(fs.readdirSync(path.join(mnt, 'data', 'usage')).filter((n) => n.includes('.tmp.')));
    expect(leftovers).toEqual([]);
  });

  it('writes again once space is freed (logging and tenants.json recover)', async () => {
    fs.rmSync(filler);
    await sleep(200);
    const prov = await get('/v1/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PROVISION_SECRET}` },
      body: JSON.stringify({ label: 'enospc-recovered' }),
    });
    expect(prov.status).toBe(201);
    await sleep(300);
    expect(alive()).toBe(true);
    const log = fs.readFileSync(logFile, 'utf8');
    expect(log).toContain('[provision] minted tenant');
    expect(fs.existsSync(path.join(mnt, 'data', 'tenants.json'))).toBe(true);
  });
});

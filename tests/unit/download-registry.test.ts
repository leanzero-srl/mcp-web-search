/**
 * Unit tests for the signed download-link registry (HMAC sign/verify).
 *
 * Env is set BEFORE importing the module: FILE_TOKEN_SECRET fixes the signing
 * secret, FILE_DOWNLOAD_BASE activates "hosted" mode, and DATA_DIR is an allowed
 * base so a temp file written there verifies. Expiry uses fake timers (the TTL
 * is read at module load, so we mint at T0 and advance the clock past it).
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TMP = mkdtempSync(path.join(tmpdir(), 'mcp-ws-dl-'));
process.env.DATA_DIR = TMP;
process.env.FILE_TOKEN_SECRET = 'unit-test-secret-abc';
process.env.FILE_DOWNLOAD_BASE = 'https://example.test';
delete process.env.PUBLIC_HOST;

import { buildDownloadUrl, verifyDownloadToken, mimeFor } from '../../src/download-registry.js';

const tokenOf = (url: string): string => new URL(url).searchParams.get('token') ?? '';
const fileUnderBase = (name: string): string => {
  const p = path.join(TMP, name);
  writeFileSync(p, 'hello world');
  return p;
};

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('download-registry sign/verify', () => {
  it('round-trips a signed URL back to the resolved path', () => {
    const f = fileUnderBase('round-trip.md');
    const url = buildDownloadUrl(f);
    expect(url).toMatch(/^https:\/\/example\.test\/files\/download\?token=/);
    const v = verifyDownloadToken(tokenOf(url!));
    expect(v).not.toBeNull();
    expect(v!.path).toBe(path.resolve(f));
  });

  it('rejects a tampered signature', () => {
    const token = tokenOf(buildDownloadUrl(fileUnderBase('tamper-sig.md'))!);
    const dot = token.lastIndexOf('.');
    const flipped = token.slice(0, dot + 1) + (token[dot + 1] === 'A' ? 'B' : 'A') + token.slice(dot + 2);
    expect(verifyDownloadToken(flipped)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const token = tokenOf(buildDownloadUrl(fileUnderBase('tamper-payload.md'))!);
    const flipped = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
    expect(verifyDownloadToken(flipped)).toBeNull();
  });

  it('rejects a signed path outside the allowed bases (escape attempt)', () => {
    // buildDownloadUrl will sign ANY path; verify must still refuse to serve a
    // file outside the allowed roots.
    const url = buildDownloadUrl('/etc/passwd');
    expect(url).not.toBeNull();
    expect(verifyDownloadToken(tokenOf(url!))).toBeNull();
  });

  it('rejects a valid token whose file no longer exists', () => {
    const f = path.join(TMP, 'never-created.md'); // under an allowed base, but absent
    expect(verifyDownloadToken(tokenOf(buildDownloadUrl(f)!))).toBeNull();
  });

  it('rejects junk / truncated tokens without throwing', () => {
    expect(verifyDownloadToken('')).toBeNull();
    expect(verifyDownloadToken('no-dot')).toBeNull();
    expect(verifyDownloadToken('abc.def')).toBeNull();
    const token = tokenOf(buildDownloadUrl(fileUnderBase('trunc.md'))!);
    // truncated signature → length-guard returns null, never throws
    expect(verifyDownloadToken(token.slice(0, token.lastIndexOf('.') + 3))).toBeNull();
  });

  it('returns null in stdio mode (no public base configured)', () => {
    const saved = process.env.FILE_DOWNLOAD_BASE;
    delete process.env.FILE_DOWNLOAD_BASE; // PUBLIC_HOST already unset
    try {
      expect(buildDownloadUrl(fileUnderBase('stdio.md'))).toBeNull();
    } finally {
      process.env.FILE_DOWNLOAD_BASE = saved;
    }
  });

  it('rejects an expired token', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const token = tokenOf(buildDownloadUrl(fileUnderBase('expired.md'))!);
      expect(verifyDownloadToken(token)).not.toBeNull(); // valid right now
      vi.setSystemTime(new Date('2026-01-03T00:00:00Z')); // +48h, past the 24h TTL
      expect(verifyDownloadToken(token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps common extensions to MIME types', () => {
    expect(mimeFor('spec.md')).toBe('text/markdown');
    expect(mimeFor('spec.json')).toBe('application/json');
    expect(mimeFor('spec.yaml')).toBe('application/yaml');
    expect(mimeFor('spec.yml')).toBe('application/yaml');
    expect(mimeFor('spec.bin')).toBe('application/octet-stream');
  });
});

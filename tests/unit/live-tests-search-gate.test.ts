import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// scripts/live-tests.sh runs the 14 SEARCH tests (~31 Serper credits a run) only when this gate says "run": every
// LIVETESTS_SEARCH_EVERY_DAYS (default 7) instead of daily, so a free 2,500-credit key lasts ~80 weeks, not ~80 days.
const GATE = path.resolve(__dirname, '../../scripts/live-tests-search-gate.sh');

describe('live-tests search gate', () => {
  let dir: string;
  let stamp: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-gate-'));
    stamp = path.join(dir, 'search.stamp');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const gate = (every: string | undefined) =>
    execFileSync('/bin/sh', ['-c', `. "$1"; search_gate "$2" ${every === undefined ? '' : `"$3"`}`, 'sh', GATE, stamp, every ?? ''],
      { encoding: 'utf8' }).trim();
  const age = (minutes: number) => {
    fs.writeFileSync(stamp, '');
    const t = (Date.now() - minutes * 60_000) / 1000;
    fs.utimesSync(stamp, t, t);
  };

  it('runs when no search run ever passed', () => {
    expect(gate('7')).toBe('run');
  });

  it('skips while the last full search run is younger than the cadence', () => {
    age(3 * 1440);
    expect(gate('7')).toBe('skip');
    age(6 * 1440);
    expect(gate('7')).toBe('skip');
  });

  it('runs once the cadence has passed, with 30 minutes of slack for the previous run duration', () => {
    age(7 * 1440 - 10); // the next 05:20 run, 10 minutes "early" because last week's run took a few minutes
    expect(gate('7')).toBe('run');
    age(8 * 1440);
    expect(gate('7')).toBe('run');
  });

  it('0 days always runs, and the default is 7', () => {
    age(60);
    expect(gate('0')).toBe('run');
    expect(gate(undefined)).toBe('skip'); // default 7 d, stamp 1 h old
  });

  it('a malformed cadence falls back to 7 days instead of running the paid tests daily', () => {
    age(60);
    expect(gate('abc')).toBe('skip');
    expect(gate('-3')).toBe('skip');
  });
});

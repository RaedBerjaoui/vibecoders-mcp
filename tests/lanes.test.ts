import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBranch, computeLane } from '../src/lanes/lane';
import { writeHandoff, readHandoff } from '../src/lanes/handoff';

describe('lanes', () => {
  it('reads the branch from a normal .git/HEAD', () => {
    const repo = mkdtempSync(join(tmpdir(), 'vibe-lane-'));
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
    expect(readBranch(repo)).toBe('feature/x');
    rmSync(repo, { recursive: true, force: true });
  });

  it('is stable per (cwd, branch) and distinct across cwds', () => {
    const a1 = computeLane('/tmp/projA');
    const a2 = computeLane('/tmp/projA');
    const b = computeLane('/tmp/projB');
    expect(a1.id).toBe(a2.id);
    expect(a1.id).not.toBe(b.id);
  });

  it('isolates handoffs per lane', () => {
    const home = mkdtempSync(join(tmpdir(), 'vibe-home-'));
    process.env.VIBECODERS_HOME = home;
    try {
      const laneA = computeLane('/tmp/projA');
      const file = writeHandoff(laneA, { goal: 'ship it', nextAction: 'run tests' }, '2026-06-19T00:00:00Z');
      expect(existsSync(file)).toBe(true);

      const md = readHandoff(laneA);
      expect(md).toContain('ship it');
      expect(md).toContain('run tests');

      // A different lane sees nothing — no cross-contamination.
      expect(readHandoff(computeLane('/tmp/projB'))).toBeUndefined();
    } finally {
      delete process.env.VIBECODERS_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRecentCommits, findGitRoot } from '../src/context/project';
import { storeMemory, recentMemories } from '../src/memory/store';
import { mkdirSync, writeFileSync } from 'node:fs';

const REFLOG = [
  '0000000000000000000000000000000000000000 aaa1111aaa Dev <dev@example.com> 1700000000 -0400\tcommit (initial): first commit',
  'aaa1111aaa bbb2222bbb Dev <dev@example.com> 1700000100 -0400\tcommit: second commit',
  'bbb2222bbb bbb2222bbb Dev <dev@example.com> 1700000200 -0400\tcheckout: moving from main to feat',
  'bbb2222bbb ccc3333ccc Dev <dev@example.com> 1700000300 -0400\tcommit (amend): third commit',
].join('\n');

describe('parseRecentCommits', () => {
  it('extracts commit entries newest-first, ignoring non-commit reflog lines', () => {
    const got = parseRecentCommits(REFLOG, 2);
    expect(got.map((c) => c.subject)).toEqual(['third commit', 'second commit']);
    expect(got[0]!.hash.startsWith('ccc3333')).toBe(true);
    expect(got[0]!.ts).toBe(1700000300);
  });
  it('returns [] for empty or commit-less reflogs', () => {
    expect(parseRecentCommits('', 5)).toEqual([]);
    expect(parseRecentCommits('x y Z <z> 1 +0000\tcheckout: moving', 5)).toEqual([]);
  });
});

describe('findGitRoot', () => {
  it('walks up to the directory containing .git, else returns the start dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'vibe-ctx-'));
    mkdirSync(join(root, '.git'));
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(findGitRoot(nested)).toBe(root);
    const orphan = mkdtempSync(join(tmpdir(), 'vibe-orphan-'));
    expect(findGitRoot(orphan)).toBe(orphan);
    rmSync(root, { recursive: true, force: true });
    rmSync(orphan, { recursive: true, force: true });
  });
});

describe('recentMemories', () => {
  it('returns the latest nodes in scope, newest-first', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vibe-recent-'));
    await storeMemory({ text: 'oldest' }, { home, scope: 'global', now: 1 });
    await storeMemory({ text: 'middle' }, { home, scope: 'global', now: 2 });
    await storeMemory({ text: 'newest' }, { home, scope: 'laneA', now: 3 });
    const got = recentMemories(['global', 'laneA'], 2, home);
    expect(got.map((n) => n.text)).toEqual(['newest', 'middle']);
    const onlyGlobal = recentMemories(['global'], 5, home);
    expect(onlyGlobal.every((n) => n.scope === 'global')).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });
});

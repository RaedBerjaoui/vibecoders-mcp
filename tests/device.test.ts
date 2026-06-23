import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchDevice, searchChatHistory } from '../src/device/tools';

describe('searchDevice (mdfind wrapper)', () => {
  it('maps mdfind stdout to a trimmed, capped path list', async () => {
    const fakeRun = async () => ({ stdout: '/a/x.ts\n/a/y.ts\n\n' });
    expect(await searchDevice('q', { limit: 5 }, fakeRun)).toEqual(['/a/x.ts', '/a/y.ts']);
  });

  it('passes -onlyin as an option BEFORE the -- terminator when a directory is given', async () => {
    let captured: string[] = [];
    const fakeRun = async (_cmd: string, args: string[]) => {
      captured = args;
      return { stdout: '' };
    };
    await searchDevice('foo bar', { onlyIn: '/proj' }, fakeRun);
    // -onlyin <dir> is an option, so it must precede `--`; the query comes after.
    expect(captured).toEqual(['-onlyin', '/proj', '--', 'foo bar']);
  });

  it('terminates option parsing with -- so a query starting with "-" is not read as a flag', async () => {
    let captured: string[] = [];
    const fakeRun = async (_cmd: string, args: string[]) => {
      captured = args;
      return { stdout: '' };
    };
    await searchDevice('-foo', {}, fakeRun);
    // `--` must sit immediately before the query so mdfind treats `-foo` literally.
    expect(captured).toEqual(['--', '-foo']);
    expect(captured[captured.indexOf('-foo') - 1]).toBe('--');
  });

  it('caps results to the limit', async () => {
    const fakeRun = async () => ({ stdout: '/1\n/2\n/3\n/4\n' });
    expect(await searchDevice('q', { limit: 2 }, fakeRun)).toEqual(['/1', '/2']);
  });
});

describe('searchChatHistory', () => {
  it('finds matching messages in a fixture transcript dir, ignoring unrelated lines', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vibe-chat-'));
    const proj = join(root, 'proj');
    mkdirSync(proj);
    writeFileSync(
      join(proj, 's.jsonl'),
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'how do I run the supabase migration' } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'use npx supabase db push for the migration' }] } }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'unrelated chit chat about lunch' } }),
      ].join('\n'),
    );
    const hits = await searchChatHistory('supabase migration', { root });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.snippet.toLowerCase()).toContain('supabase');
    expect(hits.every((h) => !h.snippet.includes('lunch'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('returns [] when the root does not exist', async () => {
    expect(await searchChatHistory('x', { root: join(tmpdir(), 'definitely-missing-xyz-123') })).toEqual([]);
  });
});

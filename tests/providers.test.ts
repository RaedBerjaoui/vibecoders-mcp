import { describe, it, expect } from 'vitest';
import {
  resolveOnPath,
  BUILTIN_PROVIDERS,
  getProvider,
  availableProviders,
  type ProviderDef,
} from '../src/providers/registry';

describe('resolveOnPath', () => {
  it('finds a binary that is on PATH', () => {
    const p = resolveOnPath('node');
    expect(p).toBeTruthy();
    expect(p).toMatch(/node$/);
  });

  it('returns undefined for a command that is not installed', () => {
    expect(resolveOnPath('definitely-not-a-real-binary-xyz')).toBeUndefined();
  });

  it('treats a path-like command literally', () => {
    expect(resolveOnPath('/no/such/path/here')).toBeUndefined();
  });
});

describe('codex provider — proven headless flags', () => {
  const codex = getProvider('codex')!;
  const argv = (mode: 'read' | 'write') => codex.args({ prompt: 'do it', mode });

  it('sends the prompt over stdin, not argv', () => {
    expect(codex.promptVia).toBe('stdin');
    expect(argv('read')).not.toContain('do it');
  });

  it('includes the flags that stop codex exec from hanging', () => {
    const a = argv('read');
    expect(a.slice(0, 4)).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
    ]);
  });

  it('runs read-only by default and workspace-write only on request', () => {
    expect(argv('read')).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
    expect(argv('write')).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write']));
  });

  it('reads the clean answer from a file and strips API creds for plan billing', () => {
    expect(codex.readsOutputFromFile).toBe(true);
    expect(codex.args({ prompt: 'x', mode: 'read', outFile: '/tmp/o.txt' })).toEqual(
      expect.arrayContaining(['--output-last-message', '/tmp/o.txt']),
    );
    expect(codex.env?.unset).toContain('OPENAI_API_KEY');
  });
});

describe('gemini provider — proven headless flags', () => {
  const gemini = getProvider('gemini')!;
  const argv = (mode: 'read' | 'write') => gemini.args({ prompt: 'do it', mode });

  it('sends the prompt over stdin with JSON output and workspace trust', () => {
    expect(gemini.promptVia).toBe('stdin');
    const a = argv('read');
    expect(a).toEqual(expect.arrayContaining(['-p', '', '-o', 'json', '--skip-trust']));
  });

  it('is read-only (plan) by default and auto_edit for write', () => {
    expect(argv('read')).toEqual(expect.arrayContaining(['--approval-mode', 'plan']));
    expect(argv('write')).toEqual(expect.arrayContaining(['--approval-mode', 'auto_edit']));
  });

  it('forces Gemini Code Assist OAuth (your plan), not the API key', () => {
    expect(gemini.env?.set?.GOOGLE_GENAI_USE_GCA).toBe('true');
    expect(gemini.env?.unset).toContain('GEMINI_API_KEY');
  });
});

describe('provider catalog', () => {
  it('every built-in provider documents that it bills via a subscription, not the API', () => {
    for (const p of BUILTIN_PROVIDERS) {
      expect(p.billing.toLowerCase()).toMatch(/plan|subscription/);
      expect(p.billing.toLowerCase()).toContain('not the');
    }
  });

  it('availableProviders keeps only providers whose CLI resolves on PATH', () => {
    const defs: ProviderDef[] = [
      {
        id: 'real',
        label: 'R',
        command: 'node',
        billing: 'x plan, not the api',
        promptVia: 'argv',
        args: () => [],
      },
      {
        id: 'fake',
        label: 'F',
        command: 'nope-xyz-binary',
        billing: 'x plan, not the api',
        promptVia: 'argv',
        args: () => [],
      },
    ];
    const got = availableProviders(defs);
    expect(got.map((g) => g.def.id)).toEqual(['real']);
    expect(got[0]?.path).toMatch(/node$/);
  });
});

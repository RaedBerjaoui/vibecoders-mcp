import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveCapability,
  isProviderConfigured,
  unconfiguredMessage,
  secretSetupHint,
  type CapabilityDef,
  type DetectContext,
} from '../src/capabilities/types';
import {
  loadVibeConfig,
  pinnedProvider,
  setPinnedProvider,
  featureEnabled,
  FEATURE_GROUPS,
  FEATURE_DEFAULTS,
  type FeatureName,
} from '../src/capabilities/config';
import { IMAGE_GEN, WEB_SEARCH, getCapability, CAPABILITIES } from '../src/capabilities/registry';
import { capabilityMatrix } from '../src/capabilities/matrix';

/** A capability with three ordered provider options for resolution tests. */
const CAP: CapabilityDef = {
  id: 'demo',
  label: 'Demo capability',
  summary: 'test',
  providers: [
    { id: 'cli-a', label: 'CLI A', requires: [{ kind: 'cli', command: 'aaa' }], setupHint: 'install aaa' },
    { id: 'api-b', label: 'API B', requires: [{ kind: 'secret', key: 'B_KEY' }], setupHint: 'set B_KEY' },
    { id: 'api-c', label: 'API C', requires: [{ kind: 'secret', key: 'C_KEY' }], setupHint: 'set C_KEY' },
  ],
};

/** Build a DetectContext from explicit allow-lists. */
const ctxOf = (clis: string[], secrets: string[]): DetectContext => ({
  hasCli: (c) => clis.includes(c),
  hasSecret: (k) => secrets.includes(k),
});

describe('isProviderConfigured', () => {
  it('is true only when every requirement is met', () => {
    const p = CAP.providers[0]!;
    expect(isProviderConfigured(p, ctxOf(['aaa'], []))).toBe(true);
    expect(isProviderConfigured(p, ctxOf([], []))).toBe(false);
  });
});

describe('resolveCapability', () => {
  it('returns unconfigured (with all options) when nothing is set up', () => {
    const r = resolveCapability(CAP, ctxOf([], []));
    expect(r.status).toBe('unconfigured');
    if (r.status === 'unconfigured') expect(r.options).toHaveLength(3);
  });

  it('picks the first configured option in declared priority order', () => {
    const r = resolveCapability(CAP, ctxOf([], ['B_KEY', 'C_KEY']));
    expect(r.status).toBe('ready');
    if (r.status === 'ready') expect(r.provider.id).toBe('api-b');
  });

  it('honours a valid pinned provider over priority order', () => {
    const r = resolveCapability(CAP, ctxOf([], ['B_KEY', 'C_KEY']), 'api-c');
    if (r.status === 'ready') expect(r.provider.id).toBe('api-c');
  });

  it('ignores a pin that is not configured and falls back to priority', () => {
    // pin cli-a, but only B_KEY is present → fall back to api-b
    const r = resolveCapability(CAP, ctxOf([], ['B_KEY']), 'cli-a');
    if (r.status === 'ready') expect(r.provider.id).toBe('api-b');
  });
});

describe('unconfiguredMessage', () => {
  it('names the capability and lists every option with its hint', () => {
    const msg = unconfiguredMessage(CAP);
    expect(msg).toContain('Demo capability');
    expect(msg).toContain('install aaa');
    expect(msg).toContain('set B_KEY');
    expect(msg).toContain('set C_KEY');
  });
});

// T30 — the secret-setup hint must be OS-aware: `vault set` writes the macOS
// Keychain ONLY, so on Linux/Windows it stores nothing and the user must be told
// the `.env` path instead. Pure function (platform passed in) so both branches
// are asserted regardless of the host OS running the suite.
describe('secretSetupHint (T30 — OS-aware)', () => {
  it('on macOS mentions BOTH `vault set` and the `.env` alternative', () => {
    const hint = secretSetupHint('OPENAI_API_KEY', true);
    expect(hint).toContain('OPENAI_API_KEY');
    expect(hint).toContain('vault set');
    expect(hint).toMatch(/\.env/);
  });

  it('on non-macOS instructs `.env` and does NOT prescribe the Keychain-only `vault set`', () => {
    const hint = secretSetupHint('BRAVE_API_KEY', false);
    expect(hint).toContain('BRAVE_API_KEY');
    expect(hint).toMatch(/\.env/);
    expect(hint).not.toContain('vault set');
  });
});

describe('image_gen capability', () => {
  it('is registered with three options: codex-cli, openai-api, gemini-api', () => {
    expect(getCapability('image_gen')).toBe(IMAGE_GEN);
    expect(CAPABILITIES).toContain(IMAGE_GEN);
    expect(IMAGE_GEN.providers.map((p) => p.id)).toEqual(['codex-cli', 'openai-api', 'gemini-api']);
  });
});

describe('web_search capability', () => {
  it('is registered with four options: gemini-cli, gemini-api, brave-api, tavily-api', () => {
    expect(getCapability('web_search')).toBe(WEB_SEARCH);
    expect(CAPABILITIES).toContain(WEB_SEARCH);
    expect(WEB_SEARCH.providers.map((p) => p.id)).toEqual([
      'gemini-cli',
      'gemini-api',
      'brave-api',
      'tavily-api',
    ]);
  });
});

describe('VibeConfig (per-user ~/.vibecoders/config.json)', () => {
  const mkPath = () => join(mkdtempSync(join(tmpdir(), 'vibe-cfg-')), 'config.json');

  it('returns an empty config when the file is absent', () => {
    const cfg = loadVibeConfig(join(tmpdir(), 'definitely-missing-vibe-config.json'));
    expect(cfg.capabilities).toEqual({});
  });

  it('tolerates a corrupt file instead of throwing', () => {
    const p = mkPath();
    writeFileSync(p, '{ not valid json');
    expect(loadVibeConfig(p).capabilities).toEqual({});
    rmSync(p, { force: true });
  });

  it('round-trips a pinned provider and persists it to disk', () => {
    const p = mkPath();
    writeFileSync(
      p,
      JSON.stringify({ capabilities: { image_gen: { provider: 'openai-api' } } }),
    );
    setPinnedProvider('image_gen', 'openai-api', p);
    const cfg = loadVibeConfig(p);
    expect(pinnedProvider(cfg, 'image_gen')).toBe('openai-api');
    // and it was actually persisted to disk
    expect(existsSync(p)).toBe(true);
    expect(JSON.parse(readFileSync(p, 'utf8')).capabilities.image_gen.provider).toBe('openai-api');
    rmSync(p, { force: true });
  });
});

describe('capabilityMatrix', () => {
  it('marks a capability ✓ and names the provider when configured', () => {
    // pretend OPENAI_API_KEY is present → image_gen resolves (codex may also be
    // on PATH, so just assert it is ready, not which provider).
    const out = capabilityMatrix((k) => k === 'OPENAI_API_KEY', { capabilities: {} });
    expect(out).toMatch(/✓ Image generation — via /);
  });

  it('marks a capability · with its options when nothing is configured', () => {
    // No secrets AND pin codex to a fake command via an isolated single-provider cap.
    const cap: CapabilityDef = {
      id: 'x',
      label: 'X',
      summary: '',
      providers: [
        { id: 'k', label: 'K', requires: [{ kind: 'secret', key: 'NOPE_KEY' }], setupHint: 'set NOPE_KEY' },
      ],
    };
    const out = capabilityMatrix(() => false, { capabilities: {} }, [cap]);
    expect(out).toContain('· X — set up one of: k');
  });
});

describe('feature flags (tasks / device / vault)', () => {
  const mkPath = () => join(mkdtempSync(join(tmpdir(), 'vibe-feat-')), 'config.json');

  it('defaults tasks on, device/vault off (personal-data tools are opt-in)', () => {
    const cfg = loadVibeConfig(join(tmpdir(), 'definitely-missing-feature-config.json'));
    expect(featureEnabled(cfg, 'tasks')).toBe(true);
    expect(featureEnabled(cfg, 'device')).toBe(false);
    expect(featureEnabled(cfg, 'vault')).toBe(false);
  });

  it('lets config.json flip a new flag (else zod would strip it)', () => {
    const p = mkPath();
    writeFileSync(p, JSON.stringify({ features: { device: true, tasks: false } }));
    const cfg = loadVibeConfig(p);
    expect(featureEnabled(cfg, 'device')).toBe(true);
    expect(featureEnabled(cfg, 'tasks')).toBe(false);
    rmSync(p, { force: true });
  });

  it('defaults the new skills group ON (curated playbooks are a core surface)', () => {
    const cfg = loadVibeConfig(join(tmpdir(), 'definitely-missing-skills-config.json'));
    expect(featureEnabled(cfg, 'skills')).toBe(true);
  });

  it('lets config.json turn skills off', () => {
    const p = mkPath();
    writeFileSync(p, JSON.stringify({ features: { skills: false } }));
    expect(featureEnabled(loadVibeConfig(p), 'skills')).toBe(false);
    rmSync(p, { force: true });
  });
});

// Host adaptation config — a flat, optional block (no unions) so Codex's schema
// converter is happy. `force` pins a client family; `adaptive:false` opts out.
describe('host adaptation config (VibeConfig.host)', () => {
  const mkPath = () => join(mkdtempSync(join(tmpdir(), 'vibe-host-')), 'config.json');

  it('parses host.force and host.adaptive through the schema', () => {
    const p = mkPath();
    writeFileSync(p, JSON.stringify({ host: { force: 'codex', adaptive: true } }));
    const cfg = loadVibeConfig(p);
    expect(cfg.host?.force).toBe('codex');
    expect(cfg.host?.adaptive).toBe(true);
    rmSync(p, { force: true });
  });

  it('leaves host undefined when the config omits it', () => {
    const cfg = loadVibeConfig(join(tmpdir(), 'definitely-missing-host-config.json'));
    expect(cfg.host).toBeUndefined();
  });

  it('strips an unknown key under host (same non-throwing strictness as the rest of the schema)', () => {
    const p = mkPath();
    writeFileSync(p, JSON.stringify({ host: { force: 'gemini', bogusKey: 123 } }));
    const cfg = loadVibeConfig(p);
    // Known key survives; the unknown one is stripped rather than retained or fatal.
    expect(cfg.host?.force).toBe('gemini');
    expect((cfg.host as Record<string, unknown>).bogusKey).toBeUndefined();
    rmSync(p, { force: true });
  });
});

// T23 — one ordered source of truth for the toggleable feature groups. The Zod
// `features` shape, the FeatureName union, FEATURE_DEFAULTS, and index.ts's
// doctor line are all DERIVED from FEATURE_GROUPS, so they can never drift. These
// tests pin the prior behavior exactly (same names, order, and default booleans).
describe('FEATURE_GROUPS (single source of truth)', () => {
  it('lists exactly the known groups, in order, with the prior defaults', () => {
    expect(FEATURE_GROUPS.map((g) => g.name)).toEqual([
      'memory',
      'reference',
      'projectContext',
      'tasks',
      'device',
      'vault',
      'rag',
      'skills',
    ]);
    // memory/reference/projectContext/tasks/rag/skills ON; device/vault OFF (opt-in personal data).
    expect(Object.fromEntries(FEATURE_GROUPS.map((g) => [g.name, g.default]))).toEqual({
      memory: true,
      reference: true,
      projectContext: true,
      tasks: true,
      device: false,
      vault: false,
      rag: true,
      skills: true,
    });
    // Every group carries a human label for the doctor status line.
    expect(FEATURE_GROUPS.every((g) => typeof g.label === 'string' && g.label.length > 0)).toBe(true);
  });

  it('derives FEATURE_DEFAULTS from the table (name → default)', () => {
    expect(FEATURE_DEFAULTS).toEqual({
      memory: true,
      reference: true,
      projectContext: true,
      tasks: true,
      device: false,
      vault: false,
      rag: true,
      skills: true,
    });
    // Keys of FEATURE_DEFAULTS are exactly the group names.
    expect(Object.keys(FEATURE_DEFAULTS).sort()).toEqual(
      FEATURE_GROUPS.map((g) => g.name).slice().sort(),
    );
  });

  it('Zod parse of an empty features object yields every default (derived shape)', () => {
    // Empty input → all defaults applied by the derived z.boolean().default(...).
    const cfg = loadVibeConfig(join(tmpdir(), 'definitely-missing-feature-groups.json'));
    for (const g of FEATURE_GROUPS) {
      expect(featureEnabled(cfg, g.name as FeatureName)).toBe(g.default);
    }
  });
});

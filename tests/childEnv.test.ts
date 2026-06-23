import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChildEnv, BASE_ENV_ALLOWLIST } from '../src/util/childEnv';
import { loadVibeConfig, delegationEnvMode } from '../src/capabilities/config';

// A unique, obviously-unrelated var name so a real leak can never collide with it.
const PLANTED = 'VIBE_TEST_UNRELATED_SECRET';

afterEach(() => {
  // Belt-and-suspenders: nothing here should set the real env (we inject a
  // `source`), but if any test ever does, this keeps the process env clean.
  delete process.env[PLANTED];
});

describe('buildChildEnv — base allowlist', () => {
  it('exports a generous base allowlist of non-secret operational vars', () => {
    // HOME + PATH are load-bearing (the CLIs auth via files under $HOME).
    expect(BASE_ENV_ALLOWLIST).toContain('PATH');
    expect(BASE_ENV_ALLOWLIST).toContain('HOME');
    expect(BASE_ENV_ALLOWLIST).toContain('USER');
    expect(BASE_ENV_ALLOWLIST).toContain('SHELL');
    expect(BASE_ENV_ALLOWLIST).toContain('TMPDIR');
    expect(BASE_ENV_ALLOWLIST).toContain('LANG');
  });
});

describe('buildChildEnv — minimal mode', () => {
  it('drops an unrelated secret while keeping PATH and HOME', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/me',
      [PLANTED]: 'super-secret',
    };
    const env = buildChildEnv({ mode: 'minimal', source });
    expect(env[PLANTED]).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/me');
  });

  it('includes a var named in `allow` (e.g. a provider API key it legitimately needs)', () => {
    const source: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'sk-test', [PLANTED]: 'nope' };
    const env = buildChildEnv({ mode: 'minimal', allow: ['OPENAI_API_KEY'], source });
    expect(env.OPENAI_API_KEY).toBe('sk-test');
    expect(env[PLANTED]).toBeUndefined();
  });

  it('omits an allow-listed var that simply is not set in the source', () => {
    const source: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const env = buildChildEnv({ mode: 'minimal', allow: ['OPENAI_API_KEY'], source });
    expect('OPENAI_API_KEY' in env).toBe(false);
  });

  it('strips a var named in `unset` even though it would otherwise be allowed', () => {
    // OPENAI_API_KEY is in `allow`, but `unset` wins — this is exactly the codex
    // case: the var is relevant to the family but must be stripped for OAuth billing.
    const source: NodeJS.ProcessEnv = { PATH: '/usr/bin', OPENAI_API_KEY: 'sk-test' };
    const env = buildChildEnv({
      mode: 'minimal',
      allow: ['OPENAI_API_KEY'],
      unset: ['OPENAI_API_KEY'],
      source,
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('captures any LC_* and XDG_* vars present (best-effort locale/config dirs)', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      LC_ALL: 'en_US.UTF-8',
      XDG_CONFIG_HOME: '/home/me/.config',
      [PLANTED]: 'nope',
    };
    const env = buildChildEnv({ mode: 'minimal', source });
    expect(env.LC_ALL).toBe('en_US.UTF-8');
    expect(env.XDG_CONFIG_HOME).toBe('/home/me/.config');
    expect(env[PLANTED]).toBeUndefined();
  });

  it('reads the real process.env when no source is injected', () => {
    process.env[PLANTED] = 'leaky';
    try {
      const env = buildChildEnv({ mode: 'minimal' });
      expect(env[PLANTED]).toBeUndefined();
      // PATH is essentially always present in a test runner.
      if (process.env.PATH) expect(env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env[PLANTED];
    }
  });
});

describe('buildChildEnv — inherit mode', () => {
  it('keeps the unrelated secret (full inheritance)', () => {
    const source: NodeJS.ProcessEnv = { PATH: '/usr/bin', [PLANTED]: 'kept' };
    const env = buildChildEnv({ mode: 'inherit', source });
    expect(env[PLANTED]).toBe('kept');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('still removes vars named in `unset` (preserves the codex OAuth stripping)', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'sk-test',
      [PLANTED]: 'kept',
    };
    const env = buildChildEnv({ mode: 'inherit', unset: ['OPENAI_API_KEY'], source });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env[PLANTED]).toBe('kept'); // only `unset` is removed, nothing else
  });
});

describe('delegationEnvMode (config glue)', () => {
  const mkPath = () => join(mkdtempSync(join(tmpdir(), 'vibe-deleg-')), 'config.json');

  it('defaults to minimal (secure) when no config exists', () => {
    const cfg = loadVibeConfig(join(tmpdir(), 'definitely-missing-deleg-config.json'));
    expect(delegationEnvMode(cfg)).toBe('minimal');
  });

  it('defaults to minimal when delegation is omitted from an existing config', () => {
    const p = mkPath();
    writeFileSync(p, JSON.stringify({ capabilities: {} }));
    expect(delegationEnvMode(loadVibeConfig(p))).toBe('minimal');
    rmSync(p, { force: true });
  });

  it('honors an explicit inherit (the opt-out) from config', () => {
    const p = mkPath();
    writeFileSync(p, JSON.stringify({ capabilities: {}, delegation: { envMode: 'inherit' } }));
    expect(delegationEnvMode(loadVibeConfig(p))).toBe('inherit');
    rmSync(p, { force: true });
  });

  it('rejects an invalid envMode (schema enum), falling back to empty config', () => {
    const p = mkPath();
    writeFileSync(p, JSON.stringify({ capabilities: {}, delegation: { envMode: 'wide-open' } }));
    // Invalid value → loadVibeConfig returns an empty config → accessor defaults to minimal.
    expect(delegationEnvMode(loadVibeConfig(p))).toBe('minimal');
    rmSync(p, { force: true });
  });
});

describe('buildChildEnv — purity', () => {
  it('does not mutate the injected source object', () => {
    const source: NodeJS.ProcessEnv = { PATH: '/usr/bin', [PLANTED]: 'x' };
    buildChildEnv({ mode: 'minimal', source });
    expect(source[PLANTED]).toBe('x'); // source untouched
    buildChildEnv({ mode: 'inherit', unset: [PLANTED], source });
    expect(source[PLANTED]).toBe('x'); // inherit+unset must not delete from source
  });
});

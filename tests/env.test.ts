/**
 * T27 — resolve `.env` from a STABLE path, not `process.cwd()`.
 *
 * A globally-registered server is launched by Claude with cwd = the user's
 * current project, so a cwd-relative `.env` is silently ignored everywhere but
 * the repo. We resolve from a stable location instead, identical between the CLI
 * (bin/vibecoders.mjs) and the server (src/config/env.ts):
 *   1. $VIBECODERS_ENV            (explicit path)
 *   2. $VIBECODERS_HOME/.env      (default ~/.vibecoders/.env)
 *   3. <package root>/.env        (final fallback)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveEnvPath } from '../src/config/env';

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});

describe('resolveEnvPath (T27 — stable .env location)', () => {
  it('honors $VIBECODERS_ENV when set (explicit path wins)', () => {
    process.env.VIBECODERS_ENV = '/tmp/custom/secrets.env';
    delete process.env.VIBECODERS_HOME;
    expect(resolveEnvPath()).toBe('/tmp/custom/secrets.env');
  });

  it('falls back to $VIBECODERS_HOME/.env when VIBECODERS_ENV is unset', () => {
    delete process.env.VIBECODERS_ENV;
    process.env.VIBECODERS_HOME = '/tmp/vibehome';
    expect(resolveEnvPath()).toBe(join('/tmp/vibehome', '.env'));
  });

  it('defaults VIBECODERS_HOME to ~/.vibecoders when neither is set', () => {
    delete process.env.VIBECODERS_ENV;
    delete process.env.VIBECODERS_HOME;
    expect(resolveEnvPath()).toBe(join(homedir(), '.vibecoders', '.env'));
  });
});

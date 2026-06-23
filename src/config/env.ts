/**
 * Configuration + secret resolution. Bring-your-own-keys, fail-closed.
 *
 * This file owns SECRETS (API keys/tokens) from the Keychain and `.env`. Its
 * sibling, ../capabilities/config.ts, owns the NON-secret per-user SETTINGS
 * (feature toggles, provider pins) at ~/.vibecoders/config.json. The boundary is
 * deliberate: secrets never touch the settings file, settings never hold a key.
 *
 * Resolution order for each secret:  Keychain  >  process.env  >  (.env file)
 * No secret is required at load time — only when a tool actually needs one,
 * at which point `require()` throws a clear, actionable error.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { keychainGet } from './secrets';

export const SECRETS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'BRAVE_API_KEY',
  'TAVILY_API_KEY',
  'GITHUB_TOKEN',
  'VERCEL_TOKEN',
  'SUPABASE_ACCESS_TOKEN',
] as const;
export type SecretKey = (typeof SECRETS)[number];

const schema = z.object({
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Wall-clock budget for any single downstream MCP operation (ms). */
  timeoutMs: z.coerce.number().int().positive().default(60_000),
});

export interface ResolvedConfig {
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  timeoutMs: number;
  /** Only the secrets actually found. Values — never log these directly. */
  secrets: ReadonlyMap<SecretKey, string>;
  has(key: SecretKey): boolean;
  /** Return the secret, or throw a clear, actionable error if absent. */
  require(key: SecretKey): string;
}

/**
 * T27 — the STABLE `.env` location, resolved the SAME way by the CLI
 * (bin/vibecoders.mjs) and the server, so a globally-registered server (whose
 * cwd is the user's project, not this repo) and the CLI never disagree:
 *   1. $VIBECODERS_ENV       — explicit path
 *   2. $VIBECODERS_HOME/.env — default ~/.vibecoders/.env
 * The package-root `.env` is a separate, final on-disk fallback handled by the
 * loader below (so a repo checkout still works without setting any env var).
 */
export function resolveEnvPath(): string {
  const explicit = process.env.VIBECODERS_ENV;
  if (explicit) return explicit;
  const home = process.env.VIBECODERS_HOME ?? join(homedir(), '.vibecoders');
  return join(home, '.env');
}

/** Package root (one level up from this module — dist/ when bundled). */
function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

/** Minimal, dependency-free `.env` parser (only fills vars not already set). */
function applyDotenv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    if (key === undefined) continue;
    const val = (m[2] ?? '').replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/**
 * Load `.env` from the stable location (resolveEnvPath), falling back to the
 * package-root `.env` if the stable one is absent. Only fills vars not already
 * set, so process.env / Keychain always win.
 */
function loadDotenvIfPresent(): void {
  const stable = resolveEnvPath();
  if (existsSync(stable)) {
    applyDotenv(stable);
    return;
  }
  applyDotenv(join(packageRoot(), '.env'));
}

export async function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedConfig> {
  if (env === process.env) loadDotenvIfPresent();
  const base = schema.parse({
    logLevel: env.VIBECODERS_LOG_LEVEL,
    timeoutMs: env.VIBECODERS_TIMEOUT_MS,
  });

  const secrets = new Map<SecretKey, string>();
  for (const key of SECRETS) {
    const value = (await keychainGet(key)) ?? env[key];
    if (value && value.trim().length > 0) secrets.set(key, value.trim());
  }

  return {
    logLevel: base.logLevel,
    timeoutMs: base.timeoutMs,
    secrets,
    has: (key) => secrets.has(key),
    require: (key) => {
      const v = secrets.get(key);
      if (!v) {
        throw new Error(
          `Missing ${key}. Set it with \`vibecoders vault set ${key}\` (stored in the macOS ` +
            `Keychain) or add it to your .env. Vibecoders never bundles keys.`,
        );
      }
      return v;
    },
  };
}

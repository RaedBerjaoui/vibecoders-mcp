/**
 * Per-user capability config at ~/.vibecoders/config.json (git-ignored).
 *
 * This file owns the NON-secret per-user SETTINGS (feature toggles, provider
 * pins, capability options). Its sibling, ../config/env.ts, owns the SECRETS
 * (API keys/tokens) from the Keychain and `.env`. The boundary is deliberate and
 * the names collide on purpose-adjacent ("config"): secrets NEVER live here, and
 * settings never hold a key. A missing file means an empty config, so every
 * capability simply auto-resolves to its first ready provider.
 *
 * Path resolution mirrors the gateway's servers.json:
 *   1. $VIBECODERS_CONFIG (explicit path)
 *   2. ~/.vibecoders/config.json (overridable via $VIBECODERS_HOME)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { ChildEnvMode } from '../util/childEnv';

/**
 * T23 — the ONE ordered source of truth for the toggleable feature groups.
 *
 * Each group is a block of MCP tools that can be turned on/off via
 * `features.<name>` in the user config. Everything below is DERIVED from this
 * table — the `FeatureName` union, `FEATURE_DEFAULTS`, the Zod `features` object
 * shape, and the doctor status line in index.ts — so a new group is declared in
 * exactly one place and can never silently drift out of any of them.
 *
 *  - `name`    the config key (`features.<name>`) and the FeatureName.
 *  - `label`   the short word shown in doctor's "Tool groups" line.
 *  - `default` whether the group is on with no user config. memory/reference/
 *              projectContext/tasks default ON; device/vault default OFF —
 *              they touch personal data (Spotlight, chat history, local notes).
 */
export const FEATURE_GROUPS = [
  { name: 'memory', label: 'memory', default: true },
  { name: 'reference', label: 'reference', default: true },
  { name: 'projectContext', label: 'project_context', default: true },
  { name: 'tasks', label: 'tasks', default: true },
  { name: 'device', label: 'device', default: false },
  { name: 'vault', label: 'vault', default: false },
] as const;

export type FeatureName = (typeof FEATURE_GROUPS)[number]['name'];

/** name → default boolean, derived from FEATURE_GROUPS (never hand-kept). */
export const FEATURE_DEFAULTS = Object.fromEntries(
  FEATURE_GROUPS.map((g) => [g.name, g.default]),
) as Record<FeatureName, boolean>;

/** The Zod object shape for `features`, derived: each key `z.boolean().default(<its default>)`. */
const featuresShape = Object.fromEntries(
  FEATURE_GROUPS.map((g) => [g.name, z.boolean().default(g.default)]),
) as { [K in FeatureName]: z.ZodDefault<z.ZodBoolean> };

const schema = z.object({
  capabilities: z
    .record(
      z.object({
        /** Pin a specific provider id; omit to auto-resolve by priority. */
        provider: z.string().optional(),
        /** Non-secret, capability-specific knobs (e.g. default model, size). */
        settings: z.record(z.unknown()).optional(),
      }),
    )
    .default({}),
  /** Memory-graph behavior. All optional; lexical recall works with no keys. */
  memory: z
    .object({
      embeddings: z.boolean().optional(),
      embedProvider: z.enum(['openai', 'gemini']).optional(),
      embedModel: z.string().optional(),
      defaultScope: z.enum(['project', 'global']).optional(),
      alpha: z.number().min(0).max(1).optional(),
    })
    .optional(),
  /** Turn whole tool groups on/off. Shape + defaults DERIVED from FEATURE_GROUPS (T23). */
  features: z.object(featuresShape).partial().optional(),
  /** Guards for the reference (URL-study) tools. */
  reference: z
    .object({
      /** Allow fetching localhost / private-range hosts (off by default — SSRF guard). */
      allowPrivateHosts: z.boolean().optional(),
      /** Extra hostnames to always allow. */
      allowHosts: z.array(z.string()).optional(),
      /** Hard cap on bytes fetched per request. */
      maxBytes: z.number().int().positive().optional(),
    })
    .optional(),
  /**
   * Delegation/spawn behavior. `envMode` controls what env the spawned CLIs
   * (codex/gemini/claude delegates, codex image_gen, gemini web_search) inherit:
   *   - 'minimal' (default, secure): only a non-secret operational allowlist
   *     plus what each provider needs — so an UNRELATED secret in the operator's
   *     environment can't leak into a child CLI's stdout/stderr (which we return
   *     in tool responses).
   *   - 'inherit': forward the full process.env (legacy behavior); opt back in
   *     only if a CLI needs an env var we don't allowlist.
   */
  delegation: z
    .object({
      envMode: z.enum(['minimal', 'inherit']).default('minimal'),
    })
    .optional(),
  /** Personal notes vault — opt-in (features.vault). Searched with the memory BM25 ranker. */
  vault: z
    .object({
      /** Directory of text notes to index. Default: ~/.vibecoders/vault. */
      dir: z.string().optional(),
      /** Hard cap on files indexed per search. */
      maxFiles: z.number().int().positive().optional(),
    })
    .optional(),
  /** Private capability overlay — owner-local BYO extensions; never shipped (see docs/private-overlay.md). */
  overlay: z
    .object({
      /** Load private modules on startup. Default true, but inert until the dir exists. */
      enabled: z.boolean().optional(),
      /** Override the overlay dir. Default: $VIBECODERS_PRIVATE_DIR or ~/.vibecoders/private. */
      dir: z.string().optional(),
    })
    .optional(),
});
export type VibeConfig = z.infer<typeof schema>;

/** Whether a feature group is enabled, honoring user config over the safe default. */
export function featureEnabled(cfg: VibeConfig, name: FeatureName): boolean {
  return cfg.features?.[name] ?? FEATURE_DEFAULTS[name];
}

/**
 * The env-inheritance mode for spawned child CLIs — 'minimal' (secure default)
 * unless the operator has explicitly opted back into 'inherit'. Keeps the spawn
 * sites' call sites clean: they pass this straight to buildChildEnv.
 */
export function delegationEnvMode(cfg: VibeConfig): ChildEnvMode {
  return cfg.delegation?.envMode ?? 'minimal';
}

export function configPath(): string {
  const explicit = process.env.VIBECODERS_CONFIG;
  if (explicit) return explicit;
  const home = process.env.VIBECODERS_HOME ?? join(homedir(), '.vibecoders');
  return join(home, 'config.json');
}

/** Read the config, tolerating absence or corruption by returning an empty one. */
export function loadVibeConfig(path = configPath()): VibeConfig {
  if (!existsSync(path)) return { capabilities: {} };
  try {
    return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    // Don't fail the server — but never silently. A single invalid key would
    // otherwise blank the WHOLE config; surface why (stderr; stdout is MCP-only).
    process.stderr.write(
      `[vibecoders] ignoring invalid config at ${path} (using defaults): ${(e as Error).message}\n`,
    );
    return { capabilities: {} };
  }
}

export function pinnedProvider(cfg: VibeConfig, capabilityId: string): string | undefined {
  return cfg.capabilities[capabilityId]?.provider;
}

/** Pin a provider for a capability and persist it; returns the updated config. */
export function setPinnedProvider(
  capabilityId: string,
  providerId: string,
  path = configPath(),
): VibeConfig {
  const cfg = loadVibeConfig(path);
  cfg.capabilities[capabilityId] = {
    ...cfg.capabilities[capabilityId],
    provider: providerId,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
  return cfg;
}

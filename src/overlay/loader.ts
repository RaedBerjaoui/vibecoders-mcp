/**
 * Private capability overlay — a generic BYO-extensions loader.
 *
 * On startup, vibecoders loads optional `register(server, deps)` modules from a
 * per-machine directory ($VIBECODERS_PRIVATE_DIR, default ~/.vibecoders/private).
 * The directory is gitignored and referenced by no public capability by name, so
 * a fresh clone ships zero private code and zero content. It runs local code the
 * user placed there themselves (same trust boundary as their shell profile).
 * Fail-closed: absent/disabled dir → no-op; a module that throws is logged to
 * stderr and skipped, never crashing the server.
 */
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '../util/logger';
import type { Lane } from '../lanes/lane';
import type { VibeConfig } from '../capabilities/config';
import { text, errorText } from '../util/mcp';

/** The stable toolkit every overlay module receives as its second argument. */
export interface OverlayDeps {
  log: Logger;
  config: VibeConfig;
  lane: Lane;
  text: typeof text;
  errorText: typeof errorText;
}

/** The shape every overlay module must export. */
export interface OverlayModule {
  register: (server: McpServer, deps: OverlayDeps) => void | Promise<void>;
}

export interface OverlayResult {
  dir: string;
  enabled: boolean;
  exists: boolean;
  loaded: string[];
  failed: Array<{ file: string; error: string }>;
}

/** Resolve the private-overlay dir: env → config → default (~/.vibecoders/private). */
export function privateDir(cfg: VibeConfig, env: NodeJS.ProcessEnv = process.env): string {
  if (env.VIBECODERS_PRIVATE_DIR) return resolve(env.VIBECODERS_PRIVATE_DIR);
  if (cfg.overlay?.dir) return resolve(cfg.overlay.dir);
  const home = env.VIBECODERS_HOME ?? homedir();
  return join(home, '.vibecoders', 'private');
}

/** Options for {@link loadOverlay}. `importer` is injectable so tests stay deterministic. */
export interface OverlayOptions {
  env?: NodeJS.ProcessEnv;
  importer?: (url: string) => Promise<unknown>;
}

function isModule(x: unknown): x is OverlayModule {
  return !!x && typeof (x as { register?: unknown }).register === 'function';
}

/**
 * Discover and load every `*.mjs`/`*.js` module in the private overlay dir,
 * calling each module's `register(server, deps)`. Fail-closed and resilient:
 * a missing/disabled dir is a no-op; an unreadable dir, an import error, or a
 * module without a `register` export is recorded in `failed` and skipped.
 */
export async function loadOverlay(
  server: McpServer,
  deps: OverlayDeps,
  opts: OverlayOptions = {},
): Promise<OverlayResult> {
  const env = opts.env ?? process.env;
  const importModule = opts.importer ?? ((url: string) => import(url));
  const dir = privateDir(deps.config, env);
  const enabled = deps.config.overlay?.enabled ?? true;
  const result: OverlayResult = { dir, enabled, exists: false, loaded: [], failed: [] };

  if (!enabled) return result;
  try {
    if (!statSync(dir).isDirectory()) return result;
  } catch {
    return result; // ENOENT or permission denied — treat as absent
  }
  result.exists = true;

  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.mjs') || f.endsWith('.js'))
      .sort();
  } catch (e) {
    deps.log.warn(`[overlay] cannot read ${dir}: ${(e as Error).message}`);
    return result;
  }

  for (const file of files) {
    const url = pathToFileURL(join(dir, file)).href;
    try {
      const mod = (await importModule(url)) as { default?: unknown };
      const candidate = mod.default ?? mod;
      if (!isModule(candidate)) {
        result.failed.push({ file, error: 'no exported register(server, deps) function' });
        continue;
      }
      await candidate.register(server, deps);
      result.loaded.push(file);
      deps.log.info(`[overlay] loaded ${file}`);
    } catch (e) {
      result.failed.push({ file, error: (e as Error).message });
      deps.log.warn(`[overlay] skipped ${file}: ${(e as Error).message}`);
    }
  }
  return result;
}

/** One-line overlay status for `doctor`. */
export function overlayStatusLine(r: OverlayResult): string {
  if (!r.enabled) return 'Private overlay: off (overlay.enabled=false)';
  if (!r.exists) return `Private overlay: none (${r.dir})`;
  const parts = [`${r.loaded.length} loaded`];
  if (r.failed.length) parts.push(`${r.failed.length} failed`);
  return `Private overlay: ${parts.join(', ')} from ${r.dir}`;
}

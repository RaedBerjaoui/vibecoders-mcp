/**
 * Gateway registry — the "swallow other MCPs" core, minus the I/O.
 *
 * Holds the set of downstream MCP servers we can mount (from servers.json) and
 * an in-memory index of every tool they expose, with a relevance search so the
 * model can find tools on demand instead of having all of them dumped into
 * context. Pure logic — no child processes here, so it's fully unit-testable.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { rankBm25, tokenize } from '../memory/rank';

/** One downstream MCP server we can mount. */
export const serverDefSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  /** Names of env vars to forward to the child (values resolved at spawn time). */
  env: z.array(z.string()).default([]),
  lazy: z.boolean().default(true),
});
export type ServerDef = z.infer<typeof serverDefSchema>;

export const serversFileSchema = z
  .object({
    servers: z.record(z.string(), serverDefSchema).default({}),
  })
  .passthrough();

/**
 * Where to read mounted-server config from, in priority order, so the gateway
 * behaves the same no matter which directory Claude Code launched it from:
 *   1. $VIBECODERS_SERVERS (explicit path)
 *   2. ~/.vibecoders/servers.json (global — overridable via VIBECODERS_HOME)
 *   3. ./servers.json (project-local default)
 */
export function resolveServersPath(): string {
  const fromEnv = process.env.VIBECODERS_SERVERS;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const home = process.env.VIBECODERS_HOME ?? join(homedir(), '.vibecoders');
  const global = join(home, 'servers.json');
  if (existsSync(global)) return global;
  return 'servers.json';
}

/** Read mounted-server config, tolerating absence or corruption by mounting nothing. */
export function loadServers(path = resolveServersPath()): Record<string, ServerDef> {
  if (!existsSync(path)) return {};
  try {
    return serversFileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).servers;
  } catch (e) {
    // Don't crash the control plane over one bad comma — but never silently. A broken
    // servers file means "no servers mounted"; surface why (stderr; stdout is MCP-only).
    process.stderr.write(
      `[vibecoders] ignoring invalid servers file at ${path} (mounting no servers): ${(e as Error).message}\n`,
    );
    return {};
  }
}

/** A tool discovered on a downstream server. */
export interface ToolMeta {
  server: string;
  /** Bare tool name on the downstream server. */
  name: string;
  /** `${server}.${name}` — the namespaced id we expose upstream. */
  qualified: string;
  description: string;
}

/** In-memory index of all known downstream tools, with relevance search. */
export class ToolIndex {
  private tools: ToolMeta[] = [];

  add(server: string, name: string, description = ''): void {
    const qualified = `${server}.${name}`;
    if (this.tools.some((t) => t.qualified === qualified)) return;
    this.tools.push({ server, name, qualified, description });
  }

  all(): readonly ToolMeta[] {
    return this.tools;
  }

  get(qualified: string): ToolMeta | undefined {
    return this.tools.find((t) => t.qualified === qualified);
  }

  /**
   * Rank tools by the repo's BM25 ranker (memory/rank.ts) over name + description —
   * the same lexical engine memory/device/vault use, so relevance is consistent and
   * IDF-aware (a term in every tool carries no signal). The tool NAME is weighted by
   * repeating its tokens, since a name match is the strongest relevance signal.
   * A blank/stopword-only query returns the first `limit` tools (nothing to rank).
   */
  search(query: string, limit = 10): ToolMeta[] {
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return this.tools.slice(0, limit);
    const docs = this.tools.map((t) => {
      const nameTokens = tokenize(`${t.qualified} ${t.name}`);
      // Repeat name tokens so a name hit outweighs a mere description mention.
      return { id: t.qualified, tokens: [...nameTokens, ...nameTokens, ...tokenize(t.description)] };
    });
    const byId = new Map(this.tools.map((t) => [t.qualified, t]));
    return rankBm25(qTokens, docs)
      .filter((s) => s.score > 0)
      .slice(0, limit)
      .map((s) => byId.get(s.id)!);
  }
}

// ---- T16: cached tool manifest (search without connecting) ----------------

/** One downstream tool as persisted in the manifest — just enough to index + search. */
export interface ManifestTool {
  name: string;
  description: string;
}
/** server name → its last-known tool list. Lets search_tools index from disk, cold. */
export type Manifest = Record<string, ManifestTool[]>;

const manifestSchema = z.record(
  z.string(),
  z.array(z.object({ name: z.string(), description: z.string().default('') })),
);

/** Where the tool manifest is cached, under $VIBECODERS_HOME (matches memory/handoff). */
export function manifestPath(): string {
  const home = process.env.VIBECODERS_HOME ?? join(homedir(), '.vibecoders');
  return join(home, 'gateway', 'manifest.json');
}

/**
 * Read the cached manifest, tolerating absence or corruption by returning {} — a cold
 * search just finds nothing and the first load_tool/call_tool re-lists + re-saves.
 */
export function loadManifest(path = manifestPath()): Manifest {
  if (!existsSync(path)) return {};
  try {
    return manifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return {};
  }
}

/** Persist the manifest (best-effort: a write failure must never break the gateway). */
export function saveManifest(manifest: Manifest, path = manifestPath()): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(manifest), 'utf8');
  } catch {
    /* a read-only/full $VIBECODERS_HOME just means no cross-session cache — non-fatal */
  }
}

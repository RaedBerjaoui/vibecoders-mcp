/**
 * Vault tools — opt-in (features.vault). A "vault" is a directory of your own
 * plain-text notes; vibecoders indexes it with the same BM25 ranker as the
 * memory graph and serves it read-only:
 *   • vault_search — rank notes by a query, return snippets
 *   • vault_read   — read one note in full (PATH-GUARDED: cannot escape the dir)
 *
 * Cores are pure (take the dir explicitly) so tests use a tmp vault.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, relative, extname, sep } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { text, errorText } from '../util/mcp';
import type { Logger } from '../util/logger';
import { rankBm25, tokenize } from '../memory/rank';

const TEXT_EXTS = new Set(['.md', '.markdown', '.mdx', '.txt', '.text', '.org', '.rst']);
const MAX_FILE_BYTES = 1_000_000;

export interface VaultHit {
  path: string;
  score: number;
  snippet: string;
}

/** Recursively collect indexable text files under a dir (bounded, dotdir-skipping). */
function walkVault(dir: string, max: number, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.length >= max) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= max) break;
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walkVault(full, max, out, depth + 1);
    else if (e.isFile() && TEXT_EXTS.has(extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

export async function searchVault(
  query: string,
  opts: { dir: string; limit?: number; maxFiles?: number },
): Promise<VaultHit[]> {
  const dir = resolve(opts.dir);
  if (!existsSync(dir)) return [];

  const docs: Array<{ id: string; tokens: string[] }> = [];
  const content = new Map<string, string>();
  for (const abs of walkVault(dir, opts.maxFiles ?? 500)) {
    let body: string;
    try {
      body = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (body.length > MAX_FILE_BYTES) continue;
    const rel = relative(dir, abs);
    docs.push({ id: rel, tokens: tokenize(body) });
    content.set(rel, body);
  }

  return rankBm25(tokenize(query), docs)
    .filter((s) => s.score > 0)
    .slice(0, opts.limit ?? 10)
    .map((s) => ({ path: s.id, score: s.score, snippet: (content.get(s.id) ?? '').slice(0, 200) }));
}

/** Read one vault file. Guards against path traversal outside the vault dir. */
export async function readVaultFile(
  p: string,
  opts: { dir: string; maxBytes?: number },
): Promise<string> {
  const base = resolve(opts.dir);
  const target = resolve(opts.dir, p);
  const escapes = (b: string, t: string): boolean => t !== b && !t.startsWith(b + sep);
  if (escapes(base, target)) throw new Error(`path escapes vault dir (paths must be relative, e.g. "ideas/note.md"): ${p}`);
  // Resolve symlinks too, so a link inside the vault can't point outside it.
  try {
    if (escapes(realpathSync(base), realpathSync(target))) {
      throw new Error(`path escapes vault dir (paths must be relative, e.g. "ideas/note.md"): ${p}`);
    }
  } catch (e) {
    if ((e as Error).message.startsWith('path escapes')) throw e;
    // target may not exist yet → let readFileSync raise the natural ENOENT below
  }
  return readFileSync(target, 'utf8').slice(0, opts.maxBytes ?? 200_000);
}

// ---- registration -----------------------------------------------------------

const expandTilde = (p: string): string => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

export function registerVault(
  server: McpServer,
  deps: { config: { dir?: string; maxFiles?: number }; log: Logger },
): void {
  const { log } = deps;
  const dir = resolve(expandTilde(deps.config.dir ?? join(homedir(), '.vibecoders', 'vault')));
  const maxFiles = deps.config.maxFiles;

  server.registerTool(
    'vault_search',
    {
      description:
        'Search your personal notes vault (a local directory of text files) by meaning. Opt-in (features.vault). Read-only.',
      inputSchema: {
        query: z.string().describe('what to look for in your notes'),
        limit: z.number().int().positive().optional().describe('max notes to return (default 10)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      if (!existsSync(dir)) {
        return text(`Vault dir not found: ${dir}. Create it, or set vault.dir in your config.`);
      }
      const hits = await searchVault(query, { dir, limit, maxFiles });
      if (!hits.length) return text('No matching notes.');
      return text(hits.map((h) => `${h.path}\n  ${h.snippet}`).join('\n\n'));
    },
  );

  server.registerTool(
    'vault_read',
    {
      description: 'Read one note from your vault in full, by its path (relative to the vault dir). Opt-in (features.vault).',
      inputSchema: {
        path: z.string().describe('note path relative to the vault dir (e.g. "ideas/caching.md")'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path: p }) => {
      try {
        return text(await readVaultFile(p, { dir }));
      } catch (e) {
        log.warn(`[vault_read] ${(e as Error).message}`);
        return errorText(`vault_read failed: ${(e as Error).message}`);
      }
    },
  );
}

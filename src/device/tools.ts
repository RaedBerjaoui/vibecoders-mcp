/**
 * Device tools — opt-in (features.device), because they read personal data:
 *   • device_search       — Spotlight (mdfind) file search across the machine (macOS only)
 *   • chat_history_search — search your OWN Claude Code transcripts (~/.claude/projects)
 *
 * Both cores are pure + injectable (a runner / a root dir) so tests never touch
 * the real Spotlight index or your real history. Ranking reuses the memory BM25.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { text, errorText } from '../util/mcp';
import type { Logger } from '../util/logger';
import { rankBm25, tokenize } from '../memory/rank';

// ---- device_search (mdfind) -------------------------------------------------

export type ExecRunner = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

const defaultRun: ExecRunner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      // mdfind exits non-zero with empty stdout on no matches in some cases;
      // treat "error but produced output" as success.
      if (err && !stdout) reject(err);
      else resolve({ stdout: stdout?.toString() ?? '' });
    });
  });

export async function searchDevice(
  query: string,
  opts: { onlyIn?: string; limit?: number } = {},
  run: ExecRunner = defaultRun,
): Promise<string[]> {
  // Options must precede `--`; `--` terminates option parsing so a query that
  // starts with `-` (e.g. "-foo") is treated literally, not as an mdfind flag.
  const args = [...(opts.onlyIn ? ['-onlyin', opts.onlyIn] : []), '--', query];
  const { stdout } = await run('mdfind', args);
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, opts.limit ?? 50);
}

// ---- chat_history_search (~/.claude/projects/**/*.jsonl) --------------------

export interface ChatHit {
  file: string;
  role: string;
  snippet: string;
  score: number;
}

/** Pull human-readable text out of a transcript line, tolerating shape variants. */
function extractText(obj: unknown): string {
  const o = obj as { message?: { content?: unknown }; content?: unknown };
  const content = o.message?.content ?? o.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? (b as { text?: string }).text ?? '' : ''))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

function roleOf(obj: unknown): string {
  const o = obj as { message?: { role?: string }; role?: string; type?: string };
  return o.message?.role ?? o.role ?? o.type ?? 'unknown';
}

/** Recursively collect *.jsonl files under a root (bounded, dotdir-skipping). */
function walkJsonl(root: string, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(root, e.name);
    if (e.isDirectory()) walkJsonl(full, out, depth + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

export async function searchChatHistory(
  query: string,
  opts: { root?: string; limit?: number } = {},
): Promise<ChatHit[]> {
  const root = opts.root ?? join(homedir(), '.claude', 'projects');
  const limit = opts.limit ?? 20;
  if (!existsSync(root)) return [];

  const docs: Array<{ id: string; tokens: string[] }> = [];
  const meta = new Map<string, { file: string; role: string; text: string }>();

  for (const file of walkJsonl(root)) {
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const txt = extractText(obj);
      if (!txt) continue;
      const id = `${file}#${i}`;
      docs.push({ id, tokens: tokenize(txt) });
      meta.set(id, { file, role: roleOf(obj), text: txt });
    }
  }

  return rankBm25(tokenize(query), docs)
    .filter((s) => s.score > 0)
    .slice(0, limit)
    .map((s) => {
      const m = meta.get(s.id)!;
      return { file: m.file, role: m.role, snippet: m.text.slice(0, 200), score: s.score };
    });
}

// ---- registration -----------------------------------------------------------

export interface DeviceDeps {
  log: Logger;
}

export function registerDevice(server: McpServer, deps: DeviceDeps): Record<string, RegisteredTool> {
  const { log } = deps;
  const deviceSearch = server.registerTool(
    'device_search',
    {
      description:
        'Search files on THIS machine by name/content via Spotlight (mdfind). macOS only. Opt-in (features.device).',
      inputSchema: {
        query: z.string().describe('a Spotlight query, e.g. a filename or a phrase'),
        onlyIn: z.string().optional().describe('restrict the search to this directory'),
        limit: z.number().int().positive().optional().describe('max paths to return (default 50)'),
      },
    },
    async ({ query, onlyIn, limit }) => {
      if (process.platform !== 'darwin') {
        return errorText('device_search is macOS-only (it uses Spotlight mdfind).');
      }
      try {
        const paths = await searchDevice(query, { onlyIn, limit });
        return text(paths.length ? paths.join('\n') : 'No matches.');
      } catch (e) {
        log.warn(`[device_search] ${(e as Error).message}`);
        return errorText(`device_search failed: ${(e as Error).message}`);
      }
    },
  );

  const chatHistorySearch = server.registerTool(
    'chat_history_search',
    {
      description:
        'Search your OWN past Claude Code conversations (~/.claude/projects transcripts) by meaning. Opt-in (features.device). Returns matching snippets with their source file.',
      inputSchema: {
        query: z.string().describe('what to look for across your prior sessions'),
        limit: z.number().int().positive().optional().describe('max snippets to return (default 20)'),
      },
    },
    async ({ query, limit }) => {
      try {
        const hits = await searchChatHistory(query, { limit });
        if (!hits.length) return text('No matching messages in your chat history.');
        return text(hits.map((h) => `[${h.role}] ${h.file}\n  ${h.snippet}`).join('\n\n'));
      } catch (e) {
        log.warn(`[chat_history_search] ${(e as Error).message}`);
        return errorText(`chat_history_search failed: ${(e as Error).message}`);
      }
    },
  );

  return { device_search: deviceSearch, chat_history_search: chatHistorySearch };
}

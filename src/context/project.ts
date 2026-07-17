/**
 * `project_context` — one call that orients a fresh session in this repo:
 * branch, recent commits, the lane handoff, the project's most recent memories,
 * and a short config snapshot. Reads git state straight from `.git` (no `git`
 * subprocess), so it is fast and safe even on slow/iCloud-backed directories.
 */
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Lane } from '../lanes/lane';
import { readHandoff } from '../lanes/handoff';
import { recentMemories } from '../memory/store';
import { featureEnabled, type VibeConfig } from '../capabilities/config';
import { text } from '../util/mcp';

export interface Commit {
  hash: string;
  subject: string;
  ts: number;
}

/**
 * Parse commit entries from a `.git/logs/HEAD` reflog, newest-first. Only real
 * commit movements are kept (checkout/reset/merge/pull lines are skipped).
 */
export function parseRecentCommits(reflog: string, limit: number): Commit[] {
  const commits: Commit[] = [];
  for (const line of reflog.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const meta = line.slice(0, tab);
    const message = line.slice(tab + 1);
    if (!/^commit(\s|:|\s*\()/.test(message)) continue; // commit:, commit (initial):, commit (amend):
    const subject = message.replace(/^commit(?:\s*\([^)]*\))?:\s*/, '').trim();
    const parts = meta.split(/\s+/);
    const hash = parts[1] ?? '';
    // meta tail is `<unix-ts> <tz>`; the timestamp is the second-to-last token.
    const ts = Number(parts[parts.length - 2]) || 0;
    commits.push({ hash, subject, ts });
  }
  return commits.reverse().slice(0, limit);
}

/** Walk up from `startDir` to the directory containing `.git`; fall back to `startDir`. */
export function findGitRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

function readReflog(gitRoot: string): string {
  const dotgit = join(gitRoot, '.git');
  try {
    // Normal repo: .git/logs/HEAD. Worktree: .git is a file → gitdir pointer.
    let logPath = join(dotgit, 'logs', 'HEAD');
    if (existsSync(dotgit) && !existsSync(logPath)) {
      const m = readFileSync(dotgit, 'utf8').match(/gitdir:\s*(.+)/);
      if (m?.[1]) logPath = join(m[1].trim(), 'logs', 'HEAD');
    }
    return existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  } catch {
    return '';
  }
}

export interface ContextDeps {
  lane: Lane;
  vibeConfig: VibeConfig;
  commitLimit?: number;
  memoryLimit?: number;
}

/** Build the human/model-readable project context blob. */
export function buildProjectContext(deps: ContextDeps): string {
  const { lane, vibeConfig } = deps;
  const root = findGitRoot(lane.cwd);
  const commits = parseRecentCommits(readReflog(root), deps.commitLimit ?? 5);
  const handoff = readHandoff(lane);
  const mems = featureEnabled(vibeConfig, 'memory')
    ? recentMemories(['global', lane.id], deps.memoryLimit ?? 5)
    : [];

  const sections: string[] = [];
  sections.push(`# Project context — ${lane.label}`);
  sections.push(`- root: ${root}\n- branch: ${lane.branch}\n- lane: ${lane.id}`);

  sections.push(
    commits.length
      ? `## Recent commits\n${commits.map((c) => `- ${c.hash.slice(0, 8)} ${c.subject}`).join('\n')}`
      : `## Recent commits\n_(none found)_`,
  );

  sections.push(
    handoff
      ? `## Handoff (this lane)\n${handoff.trim()}`
      : `## Handoff (this lane)\n_(no handoff saved — write one with write_handoff)_`,
  );

  sections.push(
    mems.length
      ? `## Recent memories\n${mems.map((m) => `- [${m.scope}] id=${m.id}: ${m.title ?? m.text.slice(0, 100)}`).join('\n')}`
      : `## Recent memories\n_(none yet — capture decisions with memory_store)_`,
  );

  return sections.join('\n\n');
}

/** Register the `project_context` tool. */
export function registerProjectContext(server: McpServer, getDeps: () => ContextDeps): void {
  server.registerTool(
    'project_context',
    {
      description:
        `Orient in THIS project fast: branch, recent commits, the saved handoff, and ` +
        `the project's most recent memories — one call, no git subprocess.`,
      inputSchema: {
        commits: z.number().int().min(0).max(30).optional().describe('How many recent commits (default 5).'),
        memories: z.number().int().min(0).max(30).optional().describe('How many recent memories (default 5).'),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const base = getDeps();
      return text(
        buildProjectContext({
          ...base,
          commitLimit: input.commits ?? base.commitLimit,
          memoryLimit: input.memories ?? base.memoryLimit,
        }),
      );
    },
  );
}

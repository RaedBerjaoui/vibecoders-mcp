import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * A "lane" is a stable identity for one working session, so concurrent sessions
 * never cross-contaminate handoffs. Derived from the project path + git branch,
 * read straight from `.git/HEAD` — no `git` subprocess, which keeps it safe on
 * slow/iCloud-backed directories.
 */
export interface Lane {
  /** Short, stable, filesystem-safe id. */
  id: string;
  /** Human-readable: `<dirname>@<branch>`. */
  label: string;
  cwd: string;
  branch: string;
}

function parseHead(head: string): string {
  const m = head.match(/ref:\s*refs\/heads\/(.+)/);
  return m?.[1] ? m[1].trim() : 'detached';
}

export function readBranch(cwd: string): string {
  const dotgit = join(cwd, '.git');
  if (!existsSync(dotgit)) return 'nogit';
  try {
    if (statSync(dotgit).isDirectory()) {
      return parseHead(readFileSync(join(dotgit, 'HEAD'), 'utf8'));
    }
    // Worktree: `.git` is a file → "gitdir: /path/to/.git/worktrees/<name>".
    const m = readFileSync(dotgit, 'utf8').match(/gitdir:\s*(.+)/);
    if (m?.[1]) return parseHead(readFileSync(join(m[1].trim(), 'HEAD'), 'utf8'));
    return 'detached';
  } catch {
    return 'nogit';
  }
}

export function computeLane(cwd: string = process.cwd()): Lane {
  const branch = readBranch(cwd);
  const dirname = cwd.split('/').filter(Boolean).pop() ?? 'root';
  const id = createHash('sha1').update(`${cwd}::${branch}`).digest('hex').slice(0, 12);
  return { id, label: `${dirname}@${branch}`, cwd, branch };
}

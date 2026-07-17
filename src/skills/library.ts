/**
 * Skills library — the pure core behind the skill_list / skill_load tools.
 *
 * A skill is a curated methodology playbook living at `<dir>/<slug>/SKILL.md`
 * with YAML-ish frontmatter (`name:` and `description:`, single-line values).
 * Two sources are scanned: the BUNDLED set shipped with the package and a USER
 * set the operator can add; a user skill of the same slug SHADOWS the bundled
 * one. The DIRECTORY SLUG is the canonical name — a mismatched frontmatter name
 * never wins, and a broken SKILL.md (no frontmatter) still lists, just with a
 * placeholder description.
 *
 * Everything here is pure and injectable: the tools resolve the directories via
 * skillDirs() and hand them in, so tests pass fixture dirs instead of touching a
 * real home. All fs is sync, matching the rest of the repo.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostId } from '../host/profile';

export interface SkillMeta {
  name: string;
  description: string;
  source: 'bundled' | 'user';
}
export interface SkillDirs {
  bundled?: string;
  user?: string;
}

/** Skill bodies are capped so one runaway file can't blow the model's context. */
const MAX_SKILL_BYTES = 64_000;
const TRUNCATION_MARKER = '\n\n[truncated at 64KB]';
/** Defense against path traversal: a valid slug is lowercase alnum + hyphens. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Where the two skill sources live.
 *
 * user — VIBECODERS_SKILLS_DIR wins; else <VIBECODERS_HOME>/skills; else
 *   ~/.vibecoders/skills. Always returned even if it doesn't exist yet; the
 *   listing tolerates an absent dir.
 * bundled — resolved relative to THIS running module, because the shipped
 *   artifact is a single esbuild bundle at dist/index.js while dev/tests run
 *   from src/skills/library.ts. From dist/index.js `../skills` is <repo>/skills;
 *   from src/skills/library.ts `../../skills` is <repo>/skills. Pick the first
 *   candidate that exists AND actually holds a `<sub>/SKILL.md` (which rules out
 *   the module's own src/skills dir); otherwise undefined.
 */
export function skillDirs(env: NodeJS.ProcessEnv = process.env): SkillDirs {
  const user =
    env.VIBECODERS_SKILLS_DIR ??
    (env.VIBECODERS_HOME
      ? join(env.VIBECODERS_HOME, 'skills')
      : join(homedir(), '.vibecoders', 'skills'));
  return { bundled: resolveBundledDir(), user };
}

function resolveBundledDir(): string | undefined {
  const candidates = [
    new URL('../skills', import.meta.url),
    new URL('../../skills', import.meta.url),
  ];
  for (const url of candidates) {
    const dir = fileURLToPath(url);
    if (dirHasSkill(dir)) return dir;
  }
  return undefined;
}

/** True when `dir` exists and at least one immediate subdir holds a SKILL.md. */
function dirHasSkill(dir: string): boolean {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  return names.some((slug) => existsSync(join(dir, slug, 'SKILL.md')));
}

/**
 * List every skill across the given dirs, bundled first then user (so a user
 * slug shadows the bundled one), sorted by name. Missing/unreadable dirs are
 * skipped silently; a subdir with no SKILL.md is not a skill; a SKILL.md with no
 * parseable frontmatter still lists with the placeholder description.
 */
export function listSkills(dirs: SkillDirs): SkillMeta[] {
  const bySlug = new Map<string, SkillMeta>();
  const sources: Array<{ source: 'bundled' | 'user'; dir?: string }> = [
    { source: 'bundled', dir: dirs.bundled },
    { source: 'user', dir: dirs.user },
  ];
  for (const { source, dir } of sources) {
    if (!dir) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // missing/unreadable dir → skip silently
    }
    for (const slug of names) {
      const md = readSkillFile(dir, slug);
      if (md === undefined) continue; // no SKILL.md here → not a skill
      bySlug.set(slug, {
        name: slug,
        description: parseDescription(md) ?? '(no description)',
        source,
      });
    }
  }
  return [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Load one skill by name, resolving user-first. Returns the full SKILL.md body
 * (frontmatter included — the description is useful context), byte-capped, then
 * the host tool-name appendix. Unknown or malformed names throw with the list of
 * available names. The slug guard runs BEFORE any fs access, so a `../` name is
 * rejected as unknown rather than escaping the skill dirs.
 */
export function loadSkill(dirs: SkillDirs, name: string, hostId: HostId): string {
  const unknown = (): Error =>
    new Error(
      `unknown skill "${name}". Available: ${listSkills(dirs)
        .map((s) => s.name)
        .join(', ')}`,
    );
  if (!SLUG_RE.test(name)) throw unknown();

  let body: string | undefined;
  for (const dir of [dirs.user, dirs.bundled]) {
    if (!dir) continue;
    body = readSkillFile(dir, name);
    if (body !== undefined) break;
  }
  if (body === undefined) throw unknown();

  return capBytes(body) + '\n\n' + hostAppendix(hostId);
}

/** Read `<dir>/<slug>/SKILL.md`, or undefined if it's absent/unreadable (also
 *  covers a `slug` that is a plain file rather than a directory). */
function readSkillFile(dir: string, slug: string): string | undefined {
  try {
    return readFileSync(join(dir, slug, 'SKILL.md'), 'utf8');
  } catch {
    return undefined;
  }
}

/** Extract the single-line `description:` from a leading `--- … ---` block. */
function parseDescription(md: string): string | undefined {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const block = m?.[1];
  if (block === undefined) return undefined;
  for (const raw of block.split('\n')) {
    const kv = /^\s*description\s*:\s*(.*)$/.exec(raw.replace(/\r$/, ''));
    if (!kv) continue;
    let val = (kv[1] ?? '').trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (val.length > 0) return val;
  }
  return undefined;
}

/** Cap to MAX_SKILL_BYTES bytes (not chars), appending a truncation marker. */
function capBytes(s: string): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= MAX_SKILL_BYTES) return s;
  return buf.subarray(0, MAX_SKILL_BYTES).toString('utf8') + TRUNCATION_MARKER;
}

/**
 * A footer mapping the action verbs skills are written in to the real tool names
 * on the calling client, so a "read a file" / "run a command" instruction lands
 * as Read/Bash on Claude Code, cat/shell on Codex, etc.
 */
export function hostAppendix(hostId: HostId): string {
  switch (hostId) {
    case 'claude-code':
      return [
        '## Tool names on this client (Claude Code)',
        '',
        '| Action | Tool |',
        '| --- | --- |',
        '| read a file | Read |',
        '| create / edit a file | Write / Edit |',
        '| run a command | Bash |',
        '| search file contents | Grep |',
        '| find files by name | Glob |',
        '| dispatch a subagent | Task |',
        '| track a todo list | TodoWrite |',
        '| web | WebSearch / WebFetch |',
      ].join('\n');
    case 'codex':
      return [
        '## Tool names on this client (Codex)',
        '',
        '| Action | Tool |',
        '| --- | --- |',
        '| read a file | shell (cat/sed) |',
        '| create / edit a file | apply_patch |',
        '| run a command | shell |',
        '| search file contents | shell (rg) |',
        '| dispatch a subagent | spawn_agent / wait_agent / close_agent |',
        '| track a todo list | update_plan |',
        '| web | web.run |',
        '',
        'Codex also loads skills natively from .agents/skills; this library is the ' +
          'curated vibecoders set served over MCP.',
      ].join('\n');
    default:
      // gemini-cli and unknown: no per-tool table to promise, so give the mapping rule.
      return [
        '## Tool names on this client',
        '',
        "Use your client's file read/edit, shell, and search tools for the actions " +
          'above; adapt names to your toolset.',
      ].join('\n');
  }
}

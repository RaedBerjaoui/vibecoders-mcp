import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostAppendix, listSkills, loadSkill, skillDirs } from '../src/skills/library';
import { registerSkills } from '../src/skills/tools';
import { PROFILES } from '../src/host/profile';
import type { Logger } from '../src/util/logger';

// Point the "bundled" source at the committed fixtures rather than the repo-root
// skills/ dir, whose contents are owned by another module and will change.
const FIXTURES = join(__dirname, 'fixtures', 'skills');
const MARKER = 'MARKER-good-skill-distinctive-body';

const tmpDirs: string[] = [];
function makeUserDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'vibe-skills-user-'));
  tmpDirs.push(d);
  return d;
}
function writeSkill(dir: string, slug: string, frontmatter: string, body: string): void {
  const sub = join(dir, slug);
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'SKILL.md'), frontmatter + body);
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('listSkills', () => {
  it('lists the fixtures sorted, with (no description) for the descriptionless one', () => {
    const skills = listSkills({ bundled: FIXTURES });
    expect(skills.map((s) => s.name)).toEqual(['good-skill', 'no-desc']);
    expect(skills.find((s) => s.name === 'good-skill')!.description).toBe('A fixture skill for tests');
    expect(skills.find((s) => s.name === 'no-desc')!.description).toBe('(no description)');
    expect(skills.every((s) => s.source === 'bundled')).toBe(true);
  });

  it('shadows a bundled skill with the user skill of the same slug, listed once', () => {
    const user = makeUserDir();
    writeSkill(
      user,
      'good-skill',
      '---\nname: good-skill\ndescription: user override\n---\n',
      '\nuser body\n',
    );
    const skills = listSkills({ bundled: FIXTURES, user });
    const goods = skills.filter((s) => s.name === 'good-skill');
    expect(goods).toHaveLength(1);
    expect(goods[0]!.source).toBe('user');
    expect(goods[0]!.description).toBe('user override');
    // the non-shadowed bundled skill is untouched
    expect(skills.find((s) => s.name === 'no-desc')!.source).toBe('bundled');
  });

  it('skips missing/unreadable dirs silently', () => {
    expect(listSkills({ bundled: join(tmpdir(), 'vibe-skills-definitely-missing') })).toEqual([]);
  });

  it('skips a non-slug directory name — list mirrors what loadSkill accepts', () => {
    const user = makeUserDir();
    // 'My_Skill' has an underscore + caps → fails SLUG_RE, so it must not list…
    writeSkill(user, 'My_Skill', '---\nname: My_Skill\ndescription: bad slug\n---\n', '\nbody\n');
    const skills = listSkills({ bundled: FIXTURES, user });
    expect(skills.map((s) => s.name)).not.toContain('My_Skill');
    // …and loadSkill must reject it WITHOUT advertising it in the Available list
    // (the self-contradiction this fix removes).
    let err: Error | undefined;
    try {
      loadSkill({ bundled: FIXTURES, user }, 'My_Skill', 'unknown');
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/unknown skill "My_Skill"/);
    const available = err!.message.split('Available:')[1] ?? '';
    expect(available).not.toContain('My_Skill');
  });
});

describe('loadSkill', () => {
  it('returns the full body including the frontmatter description', () => {
    const out = loadSkill({ bundled: FIXTURES }, 'good-skill', 'claude-code');
    expect(out).toContain('A fixture skill for tests'); // frontmatter retained
    expect(out).toContain(MARKER); // body retained
  });

  it('throws with the available names on an unknown skill', () => {
    expect(() => loadSkill({ bundled: FIXTURES }, 'nope', 'unknown')).toThrow(
      /unknown skill "nope".*good-skill.*no-desc/,
    );
  });

  it('appends tool-name notes matched to the client', () => {
    const codex = loadSkill({ bundled: FIXTURES }, 'good-skill', 'codex');
    expect(codex).toContain('apply_patch');
    expect(codex).toContain('spawn_agent');
    expect(codex).toContain('exec_command');
    expect(codex).toContain('send_message');
    expect(codex).toContain('interrupt_agent');
    expect(codex).not.toContain('close_agent');
    expect(codex).not.toMatch(/\| run a command \| shell \|/);

    const claude = loadSkill({ bundled: FIXTURES }, 'good-skill', 'claude-code');
    expect(claude).toContain('TodoWrite');

    const generic = loadSkill({ bundled: FIXTURES }, 'good-skill', 'unknown');
    expect(generic).not.toContain('apply_patch');
    expect(generic).not.toContain('spawn_agent');
    expect(generic).not.toContain('TodoWrite');
    expect(generic).toMatch(/adapt names to your toolset/);
  });

  it('rejects a traversal name without escaping to the filesystem', () => {
    expect(() => loadSkill({ bundled: FIXTURES }, '../evil', 'unknown')).toThrow(
      /unknown skill "\.\.\/evil"/,
    );
  });

  it('caps an oversized skill at 64KB and marks the truncation', () => {
    const user = makeUserDir();
    writeSkill(
      user,
      'big-skill',
      '---\nname: big-skill\ndescription: big\n---\n',
      '\n' + 'x'.repeat(70_000) + '\n',
    );
    const out = loadSkill({ user }, 'big-skill', 'unknown');
    expect(out).toContain('[truncated at 64KB]');
  });

  it('caps multi-byte content on a UTF-8 boundary (no U+FFFD from a split char)', () => {
    const user = makeUserDir();
    // '→' is 3 bytes; 64000 is not a multiple of 3, so a naive byte cut lands
    // mid-character and would decode a U+FFFD replacement char before the marker.
    writeSkill(
      user,
      'multibyte-skill',
      '---\nname: multibyte-skill\ndescription: mb\n---\n',
      '\n' + '→'.repeat(70_000) + '\n',
    );
    const out = loadSkill({ user }, 'multibyte-skill', 'unknown');
    expect(out).toContain('[truncated at 64KB]');
    expect(out).not.toContain('�'); // clean boundary, never a replacement char
  });
});

describe('hostAppendix', () => {
  it('is client-specific and always non-empty', () => {
    expect(hostAppendix('codex')).toContain('apply_patch');
    expect(hostAppendix('claude-code')).toContain('TodoWrite');
    expect(hostAppendix('gemini-cli')).toMatch(/adapt names to your toolset/);
    expect(hostAppendix('unknown')).toMatch(/adapt names to your toolset/);
  });
});

describe('skillDirs', () => {
  it('resolves the user dir from env, falling back to the vibecoders home', () => {
    expect(skillDirs({ VIBECODERS_SKILLS_DIR: '/x' }).user).toBe('/x');
    expect(skillDirs({ VIBECODERS_HOME: '/home/v' }).user).toBe(join('/home/v', 'skills'));
    expect(skillDirs({}).user).toBe(join(homedir(), '.vibecoders', 'skills'));
  });
});

describe('registerSkills', () => {
  it('registers skill_list and skill_load as enabled tools', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };
    const server = new McpServer({ name: 't', version: '0' });
    const tools = registerSkills(server, { getHost: () => PROFILES.codex, log });
    expect(tools.skill_list).toBeDefined();
    expect(tools.skill_load).toBeDefined();
    expect(tools.skill_list!.enabled).toBe(true);
    expect(tools.skill_load!.enabled).toBe(true);
  });
});

/**
 * Skills tools — two MCP tools that serve curated methodology playbooks to any
 * client. skill_list is a cheap index; skill_load returns one playbook plus a
 * host-specific tool-name footer so its action language maps to the caller's
 * real tools. Both are read-only. The pure work lives in ./library; this file
 * only wires it over MCP, mirroring registerRag (deps object, text/errorText,
 * graceful messages, flat zod schemas for Codex's schema converter).
 */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { text, errorText } from '../util/mcp';
import type { Logger } from '../util/logger';
import type { HostProfile } from '../host/profile';
import { listSkills, loadSkill, skillDirs } from './library';

export function registerSkills(
  server: McpServer,
  deps: { getHost: () => HostProfile; log: Logger },
): Record<string, RegisteredTool> {
  const { getHost, log } = deps;

  const skillList = server.registerTool(
    'skill_list',
    {
      description:
        'Curated engineering skills (methodology playbooks: debugging, TDD, verification, ' +
        'planning, parallel work, code review, security review, design). Returns names + ' +
        'one-line descriptions; load one with skill_load. Cheap to call.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const dirs = skillDirs();
      const skills = listSkills(dirs);
      if (skills.length === 0) {
        return text(
          'No skills found. Looked in the bundled set ' +
            `(${dirs.bundled ?? 'none bundled'}) and your user dir (${dirs.user}). ` +
            'Add a <slug>/SKILL.md under the user dir to define one.',
        );
      }
      const lines = skills.map(
        (s) => `${s.name} — ${s.description}${s.source === 'user' ? ' [source: user]' : ''}`,
      );
      return text(lines.join('\n'));
    },
  );

  const skillLoad = server.registerTool(
    'skill_load',
    {
      description:
        'Load one skill playbook by name (see skill_list), with tool-name notes for this ' +
        'client. Read it, then apply it to the task at hand.',
      // FLAT schema on purpose: Codex's schema converter mishandles anyOf/oneOf/$ref,
      // so no unions/nullable here.
      inputSchema: { name: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => {
      try {
        return text(loadSkill(skillDirs(), name, getHost().id));
      } catch (e) {
        const message = (e as Error).message;
        log.warn(`[skill_load] ${message}`);
        return errorText(message);
      }
    },
  );

  return { skill_list: skillList, skill_load: skillLoad };
}

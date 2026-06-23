/**
 * MCP tools to manage background delegations spawned via `delegate({background:true})`.
 * Thin wrappers over the TaskRegistry; the registry holds all the logic and the
 * formatters below are pure (unit-tested directly).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { text, errorText } from '../util/mcp';
import type { Logger } from '../util/logger';
import type { TaskRegistry, TaskRecord } from './registry';

const secs = (ms: number): string => `${Math.max(0, Math.round(ms / 1000))}s`;

/** One line per task, newest first already (registry.list order). */
export function formatTaskList(records: TaskRecord[], now: number): string {
  if (!records.length) {
    return 'No background tasks. Start one with delegate(provider, prompt, background:true).';
  }
  const lines = records.map((r) => {
    const dur = r.endedAt ? secs(r.endedAt - r.startedAt) : `${secs(now - r.startedAt)}…`;
    return `${r.id}  [${r.status}]  ${r.provider} (${r.mode})  ${dur}  ${r.promptPreview}`;
  });
  return `${records.length} background task${records.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}

/** Full detail for one task, including its (capped) output. */
export function formatTaskDetail(r: TaskRecord): string {
  return [
    `${r.id}  [${r.status}]  ${r.provider} (${r.mode})`,
    `prompt: ${r.promptPreview}`,
    '',
    '--- output ---',
    r.output || '(none yet)',
  ].join('\n');
}

export interface TasksDeps {
  tasks: TaskRegistry;
  log: Logger;
}

export function registerTasks(server: McpServer, deps: TasksDeps): void {
  const { tasks, log } = deps;

  server.registerTool(
    'tasks_list',
    {
      description:
        'List background delegations (those started with delegate background:true), newest first. Pass an id to get that task’s full output.',
      inputSchema: {
        id: z.string().optional().describe('a task id from a prior tasks_list — returns its full output'),
      },
    },
    async ({ id }) => {
      if (id) {
        const r = tasks.get(id);
        if (r) return text(formatTaskDetail(r));
        log.warn(`[tasks_list] unknown task "${id}"`);
        return errorText(`Unknown task "${id}". Run tasks_list to see active tasks.`);
      }
      return text(formatTaskList(tasks.list(), Date.now()));
    },
  );

  server.registerTool(
    'tasks_steer',
    {
      description:
        'Send a line of input to a running background task’s stdin. Best-effort: one-shot delegate CLIs may not accept input mid-run (the tool will say so).',
      inputSchema: {
        id: z.string().describe('the task id to steer'),
        input: z.string().describe('text to write to the task’s stdin'),
      },
    },
    async ({ id, input }) => {
      const r = tasks.steer(id, input);
      if (r.ok) return text(r.message);
      log.warn(`[tasks_steer] ${r.message}`);
      return errorText(r.message);
    },
  );

  server.registerTool(
    'tasks_interrupt',
    {
      description: 'Stop a running background task (SIGTERM) and mark it interrupted.',
      inputSchema: { id: z.string().describe('the task id to interrupt') },
    },
    async ({ id }) => {
      const r = tasks.interrupt(id);
      if (r.ok) return text(r.message);
      log.warn(`[tasks_interrupt] ${r.message}`);
      return errorText(r.message);
    },
  );
}

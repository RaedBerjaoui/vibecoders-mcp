import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { availableProviders, getProvider } from './registry';
import { runDelegate } from './delegate';
import { text, errorText } from '../util/mcp';
import type { Logger } from '../util/logger';
import type { TaskRegistry } from '../tasks/registry';

/** A one-line-per-provider summary of what's installed and how it bills. */
export function summarizeProviders(): string {
  const avail = availableProviders();
  if (!avail.length) {
    return 'No delegation CLIs found. Install codex, gemini, or claude to delegate work on your subscription.';
  }
  return avail.map((a) => `- ${a.def.id} (${a.def.label}) — bills via ${a.def.billing}`).join('\n');
}

/**
 * Registers the optional CLI-delegation tools. Delegation lets Claude Code hand
 * work to another coding agent's CLI so it bills through your subscription, not
 * a metered API key. If no provider CLI is installed, the tools still register
 * but report that nothing is available — nothing here is required to run.
 */
export function registerProviders(
  server: McpServer,
  deps: { log: Logger; tasks?: TaskRegistry },
): void {
  const { log, tasks } = deps;
  server.registerTool(
    'list_providers',
    {
      description:
        'List delegation providers whose CLI is installed and how each bills. Delegation routes a task to another coding agent on your subscription (its CLI), not a metered API.',
    },
    async () => text(summarizeProviders()),
  );

  server.registerTool(
    'delegate',
    {
      description:
        'Hand a task to another coding agent via its CLI — bills through your subscription, not an API key. Read-only by default; pass mode:"write" to let it modify files under cwd. Pass background:true to run it as a non-blocking task you manage with tasks_list / tasks_steer / tasks_interrupt. Call list_providers first to see what is installed.',
      inputSchema: {
        provider: z
          .string()
          .describe('codex | gemini | claude (must be installed — see list_providers)'),
        prompt: z.string().describe('the task or question for the delegated agent'),
        mode: z
          .enum(['read', 'write'])
          .optional()
          .describe('read = safe default (no file writes); write = may modify files under cwd'),
        model: z.string().optional().describe('override the model the provider uses'),
        cwd: z.string().optional().describe('working directory for the delegated agent'),
        background: z
          .boolean()
          .optional()
          .describe('run as a non-blocking background task; returns a task id immediately (manage with tasks_list/tasks_steer/tasks_interrupt)'),
      },
    },
    async ({ provider, prompt, mode, model, cwd, background }) => {
      const def = getProvider(provider);
      if (!def) return errorText(`Unknown provider "${provider}". Available:\n${summarizeProviders()}`);
      if (!availableProviders().some((a) => a.def.id === provider)) {
        return errorText(
          `Provider "${provider}" CLI ("${def.command}") is not installed. Available:\n${summarizeProviders()}`,
        );
      }
      if (background) {
        if (!tasks)
          return errorText(
            'Background delegation is disabled. Enable it with: vibecoders config set features.tasks true (then restart Claude Code).',
          );
        const id = tasks.start(def, prompt, { mode, model, cwd });
        log.info(`delegate → ${provider} (${mode ?? 'read'}) [background ${id}]`);
        return text(
          `Started background task ${id} on ${def.label}. Check it with tasks_list (pass {"id":"${id}"} for full output); stop it with tasks_interrupt.`,
        );
      }
      log.info(`delegate → ${provider} (${mode ?? 'read'})`);
      const r = await runDelegate(def, prompt, { mode, model, cwd });
      return r.ok ? text(r.output) : errorText(r.output);
    },
  );
}

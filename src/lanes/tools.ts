import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Lane } from './lane';
import { writeHandoff, readHandoff } from './handoff';
import { text } from '../util/mcp';

/**
 * Registers per-lane handoff tools. Each session's handoff is keyed to its lane,
 * so writing/recalling never touches another concurrent session's handoff.
 */
export function registerLanes(server: McpServer, lane: Lane): void {
  server.registerTool(
    'write_handoff',
    {
      description:
        `Save a handoff for THIS session's lane (${lane.label}) so a future session can resume exactly here. Lanes are isolated — concurrent sessions never mix handoffs.`,
      inputSchema: {
        goal: z.string().optional(),
        state: z.string().optional(),
        decisions: z.string().optional(),
        nextAction: z.string().optional(),
      },
      // Writes the lane's handoff file (not read-only) but only its own handoff
      // (not destructive).
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => {
      const file = writeHandoff(lane, input, new Date().toISOString());
      return text(`Handoff saved for lane ${lane.label}\n${file}`);
    },
  );

  server.registerTool(
    'recall_handoff',
    {
      description: `Load the latest handoff for THIS session's lane (${lane.label}), if any.`,
      annotations: { readOnlyHint: true },
    },
    async () => text(readHandoff(lane) ?? `No handoff yet for lane ${lane.label}.`),
  );
}

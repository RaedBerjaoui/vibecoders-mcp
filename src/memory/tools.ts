import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Lane } from '../lanes/lane';
import type { Logger } from '../util/logger';
import { text, errorText } from '../util/mcp';
import {
  storeMemory,
  recallMemory,
  walkMemory,
  forgetMemory,
  type RecallHit,
} from './store';
import { makeEmbedder, type MemoryConfig } from './embed';

// ---- pure helpers (unit-tested) ------------------------------------------

/** Which scopes a recall searches. Default: global + this lane ("all"). */
export function resolveRecallScopes(scope: string | undefined, laneId: string): string[] {
  if (!scope || scope === 'all') return ['global', laneId];
  if (scope === 'global') return ['global'];
  if (scope === 'project') return [laneId];
  return [scope];
}

/** The concrete scope a store writes to, honoring the user's configured default. */
export function resolveStoreScope(
  scope: string | undefined,
  laneId: string,
  defaultScope: 'project' | 'global',
): string {
  const choice = scope ?? defaultScope;
  if (choice === 'global') return 'global';
  if (choice === 'project') return laneId;
  return choice;
}

const clip = (s: string, n = 240): string => (s.length > n ? s.slice(0, n) + '…' : s);

/** Render recall/walk results as a compact, model-friendly list. */
export function formatHits(hits: RecallHit[], query: string): string {
  if (!hits.length) return `No memories matched "${query}".`;
  return [
    `${hits.length} memor${hits.length === 1 ? 'y' : 'ies'} for "${query}":`,
    ...hits.map((h, i) => {
      const meta = [
        `#${i + 1}`,
        `id=${h.id}`,
        `scope=${h.scope}`,
        h.type && h.type !== 'note' ? `type=${h.type}` : '',
        h.tags.length ? `tags=${h.tags.join(',')}` : '',
        typeof h.score === 'number' ? `score=${h.score.toFixed(3)}` : '',
      ].filter(Boolean).join(' · ');
      const links = h.links.length ? `\n   ↳ links: ${h.links.join(', ')}` : '';
      return `${meta}\n   ${clip(h.text)}${links}`;
    }),
  ].join('\n');
}

// ---- registration ---------------------------------------------------------

export interface MemoryDeps {
  lane: Lane;
  getSecret: (name: string) => string | undefined;
  memory: MemoryConfig;
  log: Logger;
}

/**
 * Register the memory-graph tools. A per-user, file-backed RAG store with a
 * linked graph you can walk. Lexical recall needs no keys; semantic recall
 * activates only if the user enabled embeddings with their own provider key.
 */
export function registerMemory(server: McpServer, deps: MemoryDeps): void {
  const { lane, getSecret, memory, log } = deps;
  const defaultScope = memory.defaultScope ?? 'project';
  const embed = makeEmbedder(memory, getSecret);

  server.registerTool(
    'memory_store',
    {
      description:
        `Save a durable memory to the graph (RAG-recallable later). Use for decisions, ` +
        `facts, gotchas, and links between them. scope: "project" (this repo/branch, the ` +
        `default), "global" (all your work), or a custom bucket name. Pass a stable \`id\` ` +
        `and \`links\` to build a graph you can walk.`,
      inputSchema: {
        text: z.string().min(1).describe('The fact/decision/note to remember.'),
        title: z.string().optional().describe('Short title (improves recall + linking).'),
        id: z.string().optional().describe('Stable id (kebab-case) so others can link to it.'),
        type: z.string().optional().describe('e.g. decision, fact, gotcha, todo (default: note).'),
        tags: z.array(z.string()).optional(),
        links: z.array(z.string()).optional().describe('Ids of related memories (graph edges).'),
        scope: z.string().optional().describe('"project" | "global" | custom bucket.'),
      },
    },
    async (input) => {
      try {
        const scope = resolveStoreScope(input.scope, lane.id, defaultScope);
        const node = await storeMemory(
          { text: input.text, title: input.title, id: input.id, type: input.type, tags: input.tags, links: input.links },
          { scope, now: Date.now(), embed },
        );
        const embedded = Array.isArray(node.embedding) && node.embedding.length > 0;
        return text(`Remembered · id=${node.id} · scope=${node.scope}${embedded ? ' · embedded' : ''}`);
      } catch (e) {
        log.warn(`[memory_store] ${(e as Error).message}`);
        return errorText(`Could not store memory: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'memory_recall',
    {
      description:
        `Recall memories by meaning (RAG). Searches global + this project's memory by ` +
        `default. scope: "all" (default), "project", "global", or a custom bucket.`,
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().positive().max(50).optional(),
        scope: z.string().optional(),
      },
    },
    async (input) => {
      try {
        const scopes = resolveRecallScopes(input.scope, lane.id);
        const hits = await recallMemory(input.query, {
          scopes,
          limit: input.limit ?? 8,
          embedQuery: embed,
          alpha: memory.alpha,
        });
        return text(formatHits(hits, input.query));
      } catch (e) {
        log.warn(`[memory_recall] ${(e as Error).message}`);
        return errorText(`Could not recall memories: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'memory_walk',
    {
      description:
        `Walk the memory graph from a node along its links (the connected context ` +
        `around a decision). direction: "out" (default), "in", or "both".`,
      inputSchema: {
        from: z.string().describe('The id to start from.'),
        depth: z.number().int().min(0).max(6).optional(),
        direction: z.enum(['out', 'in', 'both']).optional(),
      },
    },
    async (input) => {
      try {
        const nodes = await walkMemory(input.from, {
          depth: input.depth ?? 1,
          direction: input.direction ?? 'out',
        });
        if (!nodes.length) return text(`No node "${input.from}" in the graph (nothing to walk).`);
        const hits = nodes.map((n) => ({ ...n, score: 0 })) as RecallHit[];
        return text(formatHits(hits, `graph around ${input.from}`));
      } catch (e) {
        log.warn(`[memory_walk] ${(e as Error).message}`);
        return errorText(`Could not walk memory: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'memory_forget',
    {
      description: 'Forget a memory by id (appends a tombstone; it stops appearing in recall/walk).',
      inputSchema: { id: z.string() },
    },
    async (input) => {
      try {
        forgetMemory(input.id, Date.now());
        return text(`Forgot memory id=${input.id}.`);
      } catch (e) {
        return errorText(`Could not forget memory: ${(e as Error).message}`);
      }
    },
  );
}

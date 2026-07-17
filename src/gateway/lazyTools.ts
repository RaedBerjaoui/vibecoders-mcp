import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDef, ToolMeta } from './registry';
import { ToolIndex, loadManifest, saveManifest } from './registry';
import type { Connector } from './connector';
import type { Logger } from '../util/logger';
import { text, errorText } from '../util/mcp';

/** Defaults for bounding search_tools output so a verbose server can't dump thousands of tokens. */
const DEFAULT_MAX_DESC_CHARS = 160; // ~1–2 lines per hit
const DEFAULT_MAX_TOTAL_CHARS = 4_000; // global cap across all hits in one search

/**
 * Connect to a downstream server and index its tools into `index`. Fail-soft:
 * a broken/slow server is logged and skipped, never thrown. Shared by the lazy
 * meta-tools (index on first use) and the eager boot path (index lazy:false now).
 *
 * On a successful list it also refreshes the persisted manifest, so the NEXT cold
 * session can search this server's tools without spawning it (T16).
 */
async function indexServer(
  name: string,
  connector: Connector,
  index: ToolIndex,
  log: Logger,
): Promise<void> {
  try {
    const tools = await connector.listTools(name);
    for (const t of tools) index.add(name, t.name, t.description);
    refreshManifest(name, tools.map((t) => ({ name: t.name, description: t.description })));
  } catch (e) {
    log.warn(`could not index "${name}"`, e);
  }
}

/** Update one server's entry in the persisted manifest (best-effort, never throws). */
function refreshManifest(server: string, tools: Array<{ name: string; description: string }>): void {
  const manifest = loadManifest();
  manifest[server] = tools;
  saveManifest(manifest);
}

/**
 * Truncate one description to its first line, trimmed to `maxDescChars` with an ellipsis.
 * A downstream tool's first line is its summary; the rest is usually examples/detail —
 * exactly the context bloat the gateway exists to prevent. Returns '' for blank input.
 */
function truncateDesc(description: string, maxDescChars: number): string {
  const firstLine = description.split('\n')[0]?.trim() ?? '';
  return firstLine.length > maxDescChars
    ? firstLine.slice(0, maxDescChars).trimEnd() + '…'
    : firstLine;
}

/**
 * Render search hits as a bounded markdown list: each description truncated to ~1–2
 * lines, and the whole block capped at `maxTotalChars` so even a 50-hit search stays
 * cheap. Returns the joined string (top hits first, since `hits` arrives ranked).
 */
export function formatHits(
  hits: readonly ToolMeta[],
  opts: { maxDescChars?: number; maxTotalChars?: number } = {},
): string {
  const maxDesc = opts.maxDescChars ?? DEFAULT_MAX_DESC_CHARS;
  const maxTotal = opts.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  let out = '';
  for (const t of hits) {
    const desc = truncateDesc(t.description, maxDesc);
    const line = desc ? `- ${t.qualified} — ${desc}` : `- ${t.qualified}`;
    const next = out ? `${out}\n${line}` : line;
    if (next.length > maxTotal) break; // stop before blowing the global cap
    out = next;
  }
  return out;
}

/**
 * At boot, eagerly connect + index every server declared `lazy:false`, so its tools
 * are searchable the moment the gateway is up (lazy:true servers stay cold until first
 * use). Fail-soft like loadServers: one slow/broken eager server is logged and skipped,
 * never blocking boot. Concurrency is bounded so many eager servers can't fork a stampede.
 */
export async function connectEagerServers(
  servers: Record<string, ServerDef>,
  connector: Connector,
  index: ToolIndex,
  log: Logger,
  concurrency = 4,
): Promise<void> {
  const eager = Object.keys(servers).filter((name) => servers[name]?.lazy === false);
  if (eager.length === 0) return;
  log.info(`eagerly connecting ${eager.length} lazy:false server(s): ${eager.join(', ')}`);
  // Simple bounded worker pool: `concurrency` workers drain a shared queue of names.
  const queue = [...eager];
  const worker = async (): Promise<void> => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      await indexServer(name, connector, index, log);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, eager.length) }, worker));
}

/**
 * Registers the gateway's three meta-tools. This is the lazy loader: the model
 * sees just these, searches across every mounted server, loads one tool's
 * schema, then calls it — so hundreds of downstream tools cost ~no context.
 */
export function registerGateway(
  server: McpServer,
  servers: Record<string, ServerDef>,
  connector: Connector,
  index: ToolIndex,
  log: Logger,
): void {
  const serverNames = Object.keys(servers);
  const indexed = new Set<string>();

  // T16: hydrate the index from the persisted manifest at registration, so search_tools
  // can find tools on mounted servers WITHOUT spawning a single child. The first
  // load_tool/call_tool on a server connects it and refreshes its manifest entry. Only
  // keep entries for servers still in servers.json (a removed server shouldn't haunt search).
  for (const [name, tools] of Object.entries(loadManifest())) {
    if (!(name in servers)) continue;
    for (const t of tools) index.add(name, t.name, t.description);
  }

  async function indexLazy(name: string): Promise<void> {
    if (indexed.has(name)) return;
    await indexServer(name, connector, index, log);
    indexed.add(name);
  }

  const splitId = (id: string): [string, string] => {
    const dot = id.indexOf('.');
    return dot >= 0 ? [id.slice(0, dot), id.slice(dot + 1)] : ['', id];
  };

  server.registerTool(
    'search_tools',
    {
      description:
        'Search across every mounted MCP server for tools matching a query. Returns qualified ids (server.tool); load one with load_tool before calling it.',
      inputSchema: {
        query: z.string().describe('what you want to do, in plain words'),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      // Search the cold index built from the cached manifest — no connect here. If the
      // manifest is empty (never warmed) but servers ARE mounted, index lazily as a
      // fallback so first-run discovery still works (it then persists for next time).
      if (index.all().length === 0 && serverNames.length) {
        await Promise.all(serverNames.map(indexLazy));
      }
      const hits = index.search(query, limit ?? 10);
      if (hits.length) return text(formatHits(hits));
      return text(
        serverNames.length
          ? 'No matching tools across mounted servers.'
          : 'No downstream servers mounted yet. Add them to servers.json.',
      );
    },
  );

  server.registerTool(
    'load_tool',
    {
      description:
        'Get the full input schema for a qualified tool id (server.tool), so you can call it correctly.',
      inputSchema: { id: z.string().describe('e.g. playwright.browser_navigate') },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const [serverName] = splitId(id);
      if (!connector.has(serverName)) return errorText(`Unknown server in "${id}".`);
      await indexLazy(serverName);
      const meta = index.get(id);
      if (!meta) return errorText(`Tool "${id}" not found.`);
      const full = (await connector.listTools(serverName)).find((t) => t.name === meta.name);
      return text(
        JSON.stringify({ id, description: meta.description, inputSchema: full?.inputSchema }, null, 2),
      );
    },
  );

  server.registerTool(
    'call_tool',
    {
      description: 'Call a qualified tool (server.tool) on a mounted MCP server with arguments.',
      inputSchema: {
        id: z.string().describe('qualified id, e.g. github.create_pull_request'),
        args: z.record(z.string(), z.unknown()).optional(),
      },
      // The downstream tool is unknown, so we can make no read-only/safety claim —
      // only that it reaches outside this server (open-world).
      annotations: { openWorldHint: true },
    },
    async ({ id, args }) => {
      const [serverName, toolName] = splitId(id);
      if (!connector.has(serverName)) return errorText(`Unknown server in "${id}". Add it to servers.json.`);
      try {
        const result = await connector.callTool(serverName, toolName, args ?? {});
        return text(JSON.stringify(result));
      } catch (e) {
        return errorText(`Call failed: ${(e as Error).message}`);
      }
    },
  );
}

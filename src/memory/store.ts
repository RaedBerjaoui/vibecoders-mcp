/**
 * The memory graph: a per-user, file-backed knowledge store with RAG recall and
 * a linked graph you can walk. ZERO native dependencies — an append-only JSONL
 * log (`$VIBECODERS_HOME/memory/nodes.jsonl`) collapsed to current state on read,
 * so it is trivially portable and safe to publish.
 *
 * Recall is BM25 lexical by default (no keys). If the caller injects an `embed`
 * hook (wired only when the user configures an embedding provider with THEIR OWN
 * key), nodes carry vectors and recall blends in cosine similarity. The engine
 * itself never touches a network or a secret — that stays in the tools layer.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tokenize, rankBm25, cosine, blend, type Scored } from './rank';

export interface MemoryNode {
  id: string;
  ts: number;
  /** 'global' or a lane id — recall is scoped so projects don't bleed together. */
  scope: string;
  type: string;
  title?: string;
  text: string;
  tags: string[];
  /** Ids this node points at — the directed edges of the graph. */
  links: string[];
  /** Optional semantic vector (present only if an embedding provider was used). */
  embedding?: number[] | null;
}

interface Tombstone {
  id: string;
  ts: number;
  deleted: true;
}

type MemoryRecord = MemoryNode | Tombstone;

const isTombstone = (r: MemoryRecord): r is Tombstone =>
  (r as Tombstone).deleted === true;

// ---- pure helpers (unit-tested) ------------------------------------------

/** Reduce the append-only record log to current nodes: last-write-wins, tombstoned ids dropped. */
export function collapseNodes(records: MemoryRecord[]): MemoryNode[] {
  const byId = new Map<string, MemoryNode>();
  for (const r of records) {
    if (!r || typeof r.id !== 'string') continue;
    if (isTombstone(r)) byId.delete(r.id);
    else byId.set(r.id, r);
  }
  return [...byId.values()];
}

/** True when `node` belongs to one of the requested scopes. */
export function inScope(node: MemoryNode, scopes: string[]): boolean {
  return scopes.includes(node.scope);
}

/**
 * Breadth-first reachable set from `fromId` within `depth` hops along the graph
 * edges. Cycle-safe (visited set). `direction`: follow out-links, in-links, or both.
 */
export function walkGraph(
  nodes: MemoryNode[],
  fromId: string,
  depth: number,
  { direction = 'out' }: { direction?: 'out' | 'in' | 'both' } = {},
): MemoryNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (!byId.has(fromId)) return [];
  const neighbors = (id: string): string[] => {
    const out = byId.get(id)?.links ?? [];
    const inbound = direction === 'out' ? [] : nodes.filter((n) => n.links.includes(id)).map((n) => n.id);
    if (direction === 'in') return inbound;
    if (direction === 'both') return [...out, ...inbound];
    return out;
  };
  const visited = new Set<string>([fromId]);
  let frontier = [fromId];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of neighbors(id)) {
        if (byId.has(nb) && !visited.has(nb)) {
          visited.add(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return [...visited].map((id) => byId.get(id)!).filter(Boolean);
}

// ---- storage location -----------------------------------------------------

/** Root for all Vibecoders state; matches the rest of the app (handoff, config). */
function baseHome(home?: string): string {
  return home ?? process.env.VIBECODERS_HOME ?? join(homedir(), '.vibecoders');
}
function memoryDir(home?: string): string {
  return join(baseHome(home), 'memory');
}
export function nodesPath(home?: string): string {
  return join(memoryDir(home), 'nodes.jsonl');
}

// ---- impure: load / append ------------------------------------------------

function loadRecords(home?: string): MemoryRecord[] {
  const path = nodesPath(home);
  if (!existsSync(path)) return [];
  const out: MemoryRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip a torn/partial line rather than fail the whole store */
    }
  }
  return out;
}

/** Current nodes (collapsed). Exported so callers/tests can inspect the graph. */
export function loadNodes(home?: string): MemoryNode[] {
  return collapseNodes(loadRecords(home));
}

function appendRecord(rec: MemoryRecord, home?: string): void {
  const dir = memoryDir(home);
  mkdirSync(dir, { recursive: true });
  appendFileSync(nodesPath(home), JSON.stringify(rec) + '\n', 'utf8');
}

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'note';

function makeId(text: string, ts: number, scope: string): string {
  const head = slugify(tokenize(text).slice(0, 5).join(' '));
  const h = createHash('sha1').update(`${text}::${ts}::${scope}`).digest('hex').slice(0, 8);
  return `${head}-${h}`;
}

// ---- impure: store / recall / walk ---------------------------------------

export interface StoreInput {
  text: string;
  id?: string;
  title?: string;
  type?: string;
  tags?: string[];
  links?: string[];
}
export interface StoreOpts {
  scope: string;
  now: number;
  home?: string;
  /** Optional embedder (user-configured, own key). Failure → store lexical-only. */
  embed?: (text: string) => Promise<number[] | null>;
}

export async function storeMemory(input: StoreInput, opts: StoreOpts): Promise<MemoryNode> {
  const text = input.text.trim();
  const id = input.id?.trim() || makeId(text, opts.now, opts.scope);
  let embedding: number[] | null = null;
  if (opts.embed) {
    try {
      embedding = await opts.embed([input.title, text].filter(Boolean).join('\n'));
    } catch {
      embedding = null; // fail-closed to lexical
    }
  }
  const node: MemoryNode = {
    id,
    ts: opts.now,
    scope: opts.scope,
    type: input.type?.trim() || 'note',
    ...(input.title ? { title: input.title.trim() } : {}),
    text,
    tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
    links: (input.links ?? []).map((l) => l.trim()).filter(Boolean),
    embedding,
  };
  appendRecord(node, opts.home);
  return node;
}

export interface RecallOpts {
  scopes: string[];
  home?: string;
  limit?: number;
  /** Optional query embedder; when present and nodes have vectors, recall is hybrid. */
  embedQuery?: (text: string) => Promise<number[] | null>;
  /** Hybrid mix: 0 = pure lexical, 1 = pure semantic. Default 0.5. */
  alpha?: number;
}

export interface RecallHit extends MemoryNode {
  score: number;
}

export async function recallMemory(query: string, opts: RecallOpts): Promise<RecallHit[]> {
  const limit = opts.limit ?? 8;
  const nodes = loadNodes(opts.home).filter((n) => inScope(n, opts.scopes));
  if (nodes.length === 0) return [];

  const qTokens = tokenize(query);
  const docs = nodes.map((n) => ({
    id: n.id,
    tokens: tokenize([n.title, n.text, n.tags.join(' ')].filter(Boolean).join(' ')),
  }));
  const lexical = rankBm25(qTokens, docs);

  let ranking: Scored[] = lexical;
  if (opts.embedQuery && nodes.some((n) => Array.isArray(n.embedding) && n.embedding.length)) {
    try {
      const qv = await opts.embedQuery(query);
      if (qv && qv.length) {
        const semantic: Scored[] = nodes.map((n) => ({
          id: n.id,
          // Clamp to [0,1]: cosine can be negative (opposed text), which would
          // otherwise sink a strong lexical hit below the score>0 recall cutoff.
          score: Array.isArray(n.embedding) ? Math.max(0, cosine(qv, n.embedding)) : 0,
        }));
        ranking = blend(lexical, semantic, opts.alpha ?? 0.5);
      }
    } catch {
      /* fail-closed to lexical ranking */
    }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  return ranking
    .filter((r) => r.score > 0)
    .slice(0, limit)
    .map((r) => ({ ...byId.get(r.id)!, score: r.score }))
    .filter((h) => h.id);
}

export interface WalkOpts {
  home?: string;
  depth?: number;
  direction?: 'out' | 'in' | 'both';
}

export async function walkMemory(fromId: string, opts: WalkOpts = {}): Promise<MemoryNode[]> {
  return walkGraph(loadNodes(opts.home), fromId, opts.depth ?? 1, { direction: opts.direction ?? 'out' });
}

/** Append a tombstone so `id` no longer appears in the collapsed graph. */
export function forgetMemory(id: string, now: number, home?: string): void {
  appendRecord({ id, ts: now, deleted: true }, home);
}

/** The most recently stored nodes in the given scopes, newest-first. */
export function recentMemories(scopes: string[], limit: number, home?: string): MemoryNode[] {
  return loadNodes(home)
    .filter((n) => inScope(n, scopes))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
}

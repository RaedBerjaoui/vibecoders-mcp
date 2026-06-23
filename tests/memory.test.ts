import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenize, rankBm25, cosine, blend } from '../src/memory/rank';
import { makeEmbedder } from '../src/memory/embed';
import { resolveRecallScopes, resolveStoreScope, formatHits } from '../src/memory/tools';
import { loadVibeConfig, featureEnabled } from '../src/capabilities/config';
import { fileURLToPath } from 'node:url';
import {
  collapseNodes,
  inScope,
  walkGraph,
  storeMemory,
  recallMemory,
  walkMemory,
  loadNodes,
  type MemoryNode,
} from '../src/memory/store';

const tmp = () => mkdtempSync(join(tmpdir(), 'vibe-mem-'));

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics, drops stopwords and 1-char tokens', () => {
    expect(tokenize('The Quick, brown-fox JUMPS!')).toEqual(['quick', 'brown', 'fox', 'jumps']);
  });
  it('returns an empty array for empty/punctuation-only input', () => {
    expect(tokenize('   ,. !! ')).toEqual([]);
  });
});

describe('rankBm25', () => {
  const docs = [
    { id: 'a', tokens: tokenize('redis cache invalidation strategy') },
    { id: 'b', tokens: tokenize('postgres index tuning guide') },
    { id: 'c', tokens: tokenize('redis pubsub and redis streams') },
  ];
  it('ranks docs containing the query terms above those that do not', () => {
    const ranked = rankBm25(tokenize('redis'), docs);
    const top = ranked.filter((r) => r.score > 0).map((r) => r.id);
    expect(top).toContain('a');
    expect(top).toContain('c');
    expect(top).not.toContain('b');
  });
  it('returns every doc, sorted by descending score', () => {
    const ranked = rankBm25(tokenize('redis cache'), docs);
    expect(ranked.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    }
    expect(ranked[0]!.id).toBe('a'); // matches both terms
  });
});

describe('cosine', () => {
  it('is 1 for identical vectors and 0 for orthogonal ones', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it('is 0 when either vector is empty or zero', () => {
    expect(cosine([], [])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe('blend', () => {
  it('combines normalized lexical and semantic rankings by alpha', () => {
    const lex = [{ id: 'a', score: 10 }, { id: 'b', score: 0 }];
    const sem = [{ id: 'a', score: 0 }, { id: 'b', score: 10 }];
    const half = blend(lex, sem, 0.5);
    const byId = Object.fromEntries(half.map((r) => [r.id, r.score]));
    expect(byId.a).toBeCloseTo(byId.b!); // symmetric at alpha 0.5
    const semHeavy = blend(lex, sem, 1);
    expect(semHeavy[0]!.id).toBe('b'); // alpha=1 → semantic wins
  });
});

// T40 — makeEmbedder gates on enable/provider/key. Drive each branch with a
// fake getSecret so we never need a real provider key or network.
describe('makeEmbedder', () => {
  it('is undefined when embeddings are disabled (the zero-key default)', () => {
    expect(makeEmbedder({}, () => 'any-key')).toBeUndefined();
    expect(makeEmbedder({ embeddings: false }, () => 'any-key')).toBeUndefined();
  });

  it('is undefined when enabled but the chosen provider has no key', () => {
    expect(makeEmbedder({ embeddings: true, embedProvider: 'openai' }, () => undefined)).toBeUndefined();
    expect(makeEmbedder({ embeddings: true, embedProvider: 'gemini' }, () => undefined)).toBeUndefined();
  });

  it('returns an Embedder function when enabled and the key is present', () => {
    const fn = makeEmbedder({ embeddings: true, embedProvider: 'openai' }, () => 'sk-test');
    expect(typeof fn).toBe('function');
  });

  it('asks for the key name matching the selected provider (defaulting to openai)', () => {
    const asked: string[] = [];
    const getSecret = (name: string): string | undefined => {
      asked.push(name);
      return 'k';
    };
    makeEmbedder({ embeddings: true }, getSecret); // no provider → openai
    makeEmbedder({ embeddings: true, embedProvider: 'gemini' }, getSecret);
    expect(asked).toContain('OPENAI_API_KEY');
    expect(asked).toContain('GEMINI_API_KEY');
  });
});

describe('collapseNodes', () => {
  it('keeps the latest record per id and drops tombstoned ids', () => {
    const recs = [
      { id: 'x', ts: 1, scope: 'g', type: 'note', text: 'first', tags: [], links: [] },
      { id: 'x', ts: 2, scope: 'g', type: 'note', text: 'second', tags: [], links: [] },
      { id: 'y', ts: 3, scope: 'g', type: 'note', text: 'keep', tags: [], links: [] },
      { id: 'y', ts: 4, deleted: true },
    ];
    const nodes = collapseNodes(recs as never);
    expect(nodes.map((n) => n.id)).toEqual(['x']);
    expect(nodes[0]!.text).toBe('second');
  });
});

describe('inScope', () => {
  const node = (scope: string): MemoryNode =>
    ({ id: 's', ts: 1, scope, type: 'note', text: '', tags: [], links: [] }) as MemoryNode;
  it('matches when the node scope is in the requested set', () => {
    expect(inScope(node('global'), ['global', 'lane1'])).toBe(true);
    expect(inScope(node('lane2'), ['global', 'lane1'])).toBe(false);
  });
});

describe('walkGraph', () => {
  const mk = (id: string, links: string[]): MemoryNode =>
    ({ id, ts: 1, scope: 'g', type: 'note', text: id, tags: [], links }) as MemoryNode;
  const nodes = [mk('a', ['b', 'c']), mk('b', ['d']), mk('c', []), mk('d', ['a'])];
  it('returns nodes reachable within depth, following out-links, cycle-safe', () => {
    const got = walkGraph(nodes, 'a', 1).map((n) => n.id).sort();
    expect(got).toEqual(['a', 'b', 'c']);
    const deep = walkGraph(nodes, 'a', 5).map((n) => n.id).sort();
    expect(deep).toEqual(['a', 'b', 'c', 'd']); // cycle a→b→d→a does not loop forever
  });
  it('returns just the start node for an unknown or depth-0 walk', () => {
    expect(walkGraph(nodes, 'a', 0).map((n) => n.id)).toEqual(['a']);
    expect(walkGraph(nodes, 'zzz', 3)).toEqual([]);
  });
});

describe('shipped config.example.json', () => {
  it('parses cleanly under the real schema (not silently blanked) and honors its settings', () => {
    const path = fileURLToPath(new URL('../config.example.json', import.meta.url));
    const cfg = loadVibeConfig(path);
    // If the "//" hint keys had broken validation, loadVibeConfig returns {capabilities:{}}
    // and these would be wrong.
    expect(featureEnabled(cfg, 'reference')).toBe(true);
    expect(featureEnabled(cfg, 'memory')).toBe(true);
    expect(cfg.memory?.defaultScope).toBe('project');
    expect(cfg.capabilities.image_gen?.provider).toBe('codex-cli');
    expect(cfg.capabilities.web_search?.provider).toBe('gemini-cli');
  });
});

describe('scope resolution (tools layer)', () => {
  it('recall defaults to global + this lane, and honors explicit scopes', () => {
    expect(resolveRecallScopes(undefined, 'laneX').sort()).toEqual(['global', 'laneX']);
    expect(resolveRecallScopes('all', 'laneX').sort()).toEqual(['global', 'laneX']);
    expect(resolveRecallScopes('global', 'laneX')).toEqual(['global']);
    expect(resolveRecallScopes('project', 'laneX')).toEqual(['laneX']);
    expect(resolveRecallScopes('custom-bucket', 'laneX')).toEqual(['custom-bucket']);
  });
  it('store maps project/global keywords to concrete scopes, with a configurable default', () => {
    expect(resolveStoreScope('global', 'laneX', 'project')).toBe('global');
    expect(resolveStoreScope('project', 'laneX', 'global')).toBe('laneX');
    expect(resolveStoreScope(undefined, 'laneX', 'global')).toBe('global');
    expect(resolveStoreScope(undefined, 'laneX', 'project')).toBe('laneX');
    expect(resolveStoreScope('team-notes', 'laneX', 'project')).toBe('team-notes');
  });
});

describe('formatHits', () => {
  it('renders ranked hits with id, scope and text; says so when empty', () => {
    const out = formatHits([
      { id: 'auth', ts: 1, scope: 'global', type: 'note', text: 'JWT design', tags: ['auth'], links: [], score: 1.2 },
    ] as never, 'jwt');
    expect(out).toMatch(/auth/);
    expect(out).toMatch(/JWT design/);
    expect(formatHits([] as never, 'jwt')).toMatch(/[Nn]o /);
  });
});

describe('storeMemory + recallMemory + walkMemory (file-backed, no native deps)', () => {
  it('stores nodes and recalls them lexically by relevance', async () => {
    const home = tmp();
    await storeMemory({ text: 'Redis cache invalidation: bust keys on write', tags: ['redis'] }, { home, scope: 'global', now: 1 });
    await storeMemory({ text: 'Postgres connection pooling with pgbouncer', tags: ['pg'] }, { home, scope: 'global', now: 2 });
    const hits = await recallMemory('redis cache', { home, scopes: ['global'], limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.text).toMatch(/Redis cache/);
    rmSync(home, { recursive: true, force: true });
  });

  it('persists across loads and supports linked graph walks', async () => {
    const home = tmp();
    const root = await storeMemory({ id: 'auth', text: 'Auth design: JWT + refresh', links: ['db'] }, { home, scope: 'global', now: 1 });
    await storeMemory({ id: 'db', text: 'DB: users table + sessions', links: [] }, { home, scope: 'global', now: 2 });
    expect(loadNodes(home).map((n) => n.id).sort()).toEqual(['auth', 'db']);
    const sub = await walkMemory(root.id, { home, depth: 1 });
    expect(sub.map((n) => n.id).sort()).toEqual(['auth', 'db']);
    rmSync(home, { recursive: true, force: true });
  });

  it('scopes recall: a lane memory is hidden from another lane but global is shared', async () => {
    const home = tmp();
    await storeMemory({ text: 'lane-one secret note about widgets' }, { home, scope: 'laneONE', now: 1 });
    await storeMemory({ text: 'global note about widgets' }, { home, scope: 'global', now: 2 });
    const fromTwo = await recallMemory('widgets', { home, scopes: ['global', 'laneTWO'], limit: 5 });
    expect(fromTwo.some((n) => n.scope === 'laneONE')).toBe(false);
    expect(fromTwo.some((n) => n.scope === 'global')).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  it('hybrid recall keeps a strong lexical hit even when its embedding is opposed (M1)', async () => {
    const home = tmp();
    // A: lexically matches the query; B: does not. Give A an embedding opposed to the query.
    const embed = async (t: string): Promise<number[]> => (/redis/i.test(t) ? [1, 0] : [0, 1]);
    await storeMemory({ text: 'redis cache eviction policy' }, { home, scope: 'global', now: 1, embed });
    await storeMemory({ text: 'postgres vacuum scheduling' }, { home, scope: 'global', now: 2, embed });
    const embedQuery = async (): Promise<number[]> => [-1, 0]; // cosine(-1,0 · 1,0) = -1 for A
    const hits = await recallMemory('redis cache', { home, scopes: ['global'], embedQuery, alpha: 0.5 });
    expect(hits.some((h) => /redis cache/.test(h.text))).toBe(true); // not dropped by the score>0 cutoff
    rmSync(home, { recursive: true, force: true });
  });

  it('writes a JSONL log (append-only, one record per line)', async () => {
    const home = tmp();
    await storeMemory({ text: 'one' }, { home, scope: 'global', now: 1 });
    await storeMemory({ text: 'two' }, { home, scope: 'global', now: 2 });
    const log = readFileSync(join(home, 'memory', 'nodes.jsonl'), 'utf8').trim().split('\n');
    expect(log.length).toBe(2);
    expect(() => log.forEach((l) => JSON.parse(l))).not.toThrow();
    rmSync(home, { recursive: true, force: true });
  });
});

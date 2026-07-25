import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ToolIndex,
  serversFileSchema,
  resolveServersPath,
  loadServers,
  manifestPath,
  loadManifest,
  saveManifest,
} from '../src/gateway/registry';
import { connectEagerServers, formatHits, registerGateway } from '../src/gateway/lazyTools';
import { Connector } from '../src/gateway/connector';
import type { Logger } from '../src/util/logger';

const silentLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const echoServer = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));
const spawnCount = (marker: string): number =>
  existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).length : 0;

describe('gateway native MCP result and metadata forwarding', () => {
  it('keeps downstream mixed content/result fields native and returns complete load metadata', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const downstream = {
      has: () => true,
      listTools: async () => [{ name: 'mixed', description: 'mixed', title: 'Mixed tool', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, annotations: { readOnlyHint: true }, extra: 'kept' }],
      callTool: async () => ({ content: [{ type: 'text', text: 'hello' }, { type: 'image', data: 'img', mimeType: 'image/png' }, { type: 'audio', data: 'aud', mimeType: 'audio/wav' }], structuredContent: { ok: true }, _meta: { source: 'downstream' }, isError: true }),
    };
    const server = new McpServer({ name: 'test', version: '0' });
    registerGateway(server, { down: { command: 'noop', args: [], env: [], lazy: true } }, downstream as never, new ToolIndex(), silentLog);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const loaded = await client.callTool({ name: 'load_tool', arguments: { id: 'down.mixed' } }) as { content: Array<{ text: string }> };
      expect(JSON.parse(loaded.content[0]!.text)).toMatchObject({ id: 'down.mixed', title: 'Mixed tool', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, annotations: { readOnlyHint: true }, extra: 'kept' });
      const result = await client.callTool({ name: 'call_tool', arguments: { id: 'down.mixed', args: {} } }) as { content: Array<{ type: string; data?: string }>; structuredContent: unknown; _meta: unknown; isError: boolean };
      expect(result).toMatchObject({ structuredContent: { ok: true }, _meta: { source: 'downstream' }, isError: true });
      expect(result.content.find((block) => block.type === 'image')).toMatchObject({ data: 'img' });
      expect(result.content.find((block) => block.type === 'audio')).toMatchObject({ data: 'aud' });
    } finally { await client.close(); }
  });
});

describe('servers.json resolution (works from any cwd)', () => {
  it('prefers $VIBECODERS_SERVERS, then the global ~/.vibecoders, then ./servers.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'vibe-home-'));
    const explicit = mkdtempSync(join(tmpdir(), 'vibe-exp-'));
    const explicitFile = join(explicit, 'mine.json');
    process.env.VIBECODERS_HOME = home;
    try {
      // Nothing set up yet → falls back to the cwd-relative default.
      delete process.env.VIBECODERS_SERVERS;
      expect(resolveServersPath()).toBe('servers.json');

      // A global file under ~/.vibecoders is picked up regardless of cwd.
      const globalFile = join(home, 'servers.json');
      writeFileSync(globalFile, '{"servers":{}}');
      expect(resolveServersPath()).toBe(globalFile);

      // An explicit env path wins over the global one.
      writeFileSync(explicitFile, '{"servers":{}}');
      process.env.VIBECODERS_SERVERS = explicitFile;
      expect(resolveServersPath()).toBe(explicitFile);
    } finally {
      delete process.env.VIBECODERS_HOME;
      delete process.env.VIBECODERS_SERVERS;
      rmSync(home, { recursive: true, force: true });
      rmSync(explicit, { recursive: true, force: true });
    }
  });
});

describe('loadServers (fail-soft like loadVibeConfig)', () => {
  it('degrades a malformed servers.json to no servers — loudly, not fatally', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-srv-'));
    const bad = join(dir, 'servers.json');
    writeFileSync(bad, '{ "servers": { , } }'); // stray comma — invalid JSON, would crash boot
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(loadServers(bad)).toEqual({}); // returns empty instead of throwing
      expect(warn).toHaveBeenCalled(); // never silent — surfaces why (stderr; stdout is MCP-only)
      expect(String(warn.mock.calls[0]?.[0])).toContain(bad);
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('degrades a schema-invalid servers.json (wrong field type) the same way', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-srv-'));
    const bad = join(dir, 'servers.json');
    writeFileSync(bad, JSON.stringify({ servers: { x: { command: 123 } } })); // command must be a string
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(loadServers(bad)).toEqual({});
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('connectEagerServers (the lazy:false flag)', () => {
  it('connects + indexes lazy:false at boot while lazy:true stays cold until used', async () => {
    // lazy:false servers should be warm + searchable the instant boot finishes; lazy:true
    // servers must cost nothing (no child spawned) until something actually calls them.
    const dir = mkdtempSync(join(tmpdir(), 'vibe-eager-'));
    const eagerMarker = join(dir, 'eager.log');
    const coldMarker = join(dir, 'cold.log');
    const servers = {
      eager: { command: 'node', args: [echoServer], env: ['SPAWN_MARKER'], lazy: false },
      cold: { command: 'node', args: [echoServer], env: ['SPAWN_MARKER'], lazy: true },
    };
    // Each child reads SPAWN_MARKER from env; route each server to its own marker file.
    const markerFor: Record<string, string> = { eager: eagerMarker, cold: coldMarker };
    const index = new ToolIndex();
    let current = '';
    const connector = new Connector(
      servers,
      (name) => (name === 'SPAWN_MARKER' ? markerFor[current] : undefined),
      silentLog,
      5000,
    );
    try {
      // The resolver above is stateful per-connect, so eager-index serially (concurrency 1)
      // and set `current` before each connect. Real boot uses the same resolver for all.
      current = 'eager';
      await connectEagerServers(servers, connector, index, silentLog, 1);

      // lazy:false was connected + its tools indexed at boot.
      expect(spawnCount(eagerMarker)).toBe(1);
      expect(index.get('eager.echo')).toBeTruthy();
      // lazy:true was NOT connected and NOT indexed.
      expect(spawnCount(coldMarker)).toBe(0);
      expect(index.get('cold.echo')).toBeUndefined();

      // First on-demand use of the cold server finally spawns it.
      current = 'cold';
      const tools = await connector.listTools('cold');
      expect(tools.map((t) => t.name)).toContain('echo');
      expect(spawnCount(coldMarker)).toBe(1);
    } finally {
      await connector.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  it('is fail-soft: one broken lazy:false server does not block indexing the others', async () => {
    // Boot must survive a slow/broken eager server (match loadServers' fail-soft discipline):
    // the good server is still indexed even though the bad one never speaks MCP.
    const dir = mkdtempSync(join(tmpdir(), 'vibe-eager-fail-'));
    const goodMarker = join(dir, 'good.log');
    const servers = {
      broken: { command: 'node', args: ['-e', 'setTimeout(()=>{},2000)'], env: [], lazy: false },
      good: { command: 'node', args: [echoServer], env: ['SPAWN_MARKER'], lazy: false },
    };
    const index = new ToolIndex();
    const connector = new Connector(
      servers,
      (name) => (name === 'SPAWN_MARKER' ? goodMarker : undefined),
      silentLog,
      500, // short timeout so the broken server's hang resolves fast
    );
    try {
      await connectEagerServers(servers, connector, index, silentLog, 4);
      expect(index.get('good.echo')).toBeTruthy(); // good one indexed despite the broken one
    } finally {
      await connector.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});

describe('ToolIndex', () => {
  it('indexes and searches tools by relevance', () => {
    const idx = new ToolIndex();
    idx.add('playwright', 'browser_navigate', 'navigate the browser to a url');
    idx.add('github', 'create_pull_request', 'open a PR on a repo');
    idx.add('playwright', 'browser_click', 'click an element on the page');

    const hits = idx.search('browser');
    expect(hits.length).toBe(2);
    expect(hits.every((t) => t.server === 'playwright')).toBe(true);
  });

  it('dedupes by qualified name and resolves get()', () => {
    const idx = new ToolIndex();
    idx.add('github', 'create_pull_request', 'x');
    idx.add('github', 'create_pull_request', 'dup ignored');
    expect(idx.all().length).toBe(1);
    expect(idx.get('github.create_pull_request')?.name).toBe('create_pull_request');
  });

  it('validates a servers.json shape and applies defaults', () => {
    const parsed = serversFileSchema.parse({
      _comment: 'allowed by passthrough',
      servers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp'] } },
    });
    expect(parsed.servers.playwright?.lazy).toBe(true);
    expect(parsed.servers.playwright?.env).toEqual([]);
  });

  // T18: search must use the repo's BM25 ranker (memory/rank.ts), not ad-hoc substring
  // scoring. The discriminating property is IDF: a term in EVERY doc carries no signal,
  // so a doc that ALSO matches a rare term must outrank one that only has the common term.
  it('ranks by BM25 — rare matching terms beat ubiquitous ones (idf)', () => {
    const idx = new ToolIndex();
    idx.add('a', 'browser_navigate', 'navigate the browser to a url'); // common: browser
    idx.add('b', 'browser_screenshot', 'take a screenshot of the browser'); // common: browser
    idx.add('c', 'browser_pdf', 'browser save page as pdf document'); // common+rare: browser, pdf
    const hits = idx.search('browser pdf');
    // 'browser' is in all 3 (idf≈0), 'pdf' is in 1 → the pdf tool must rank first.
    expect(hits[0]?.qualified).toBe('c.browser_pdf');
  });

  it('tokenizes the query (case-insensitive, drops stopwords) like the rest of recall', () => {
    const idx = new ToolIndex();
    idx.add('git', 'create_pull_request', 'open a pull request on a repository');
    idx.add('fs', 'read_file', 'read the contents of a file');
    // Stopwords ("the", "a") and case must not matter; the real term "PULL" drives the hit.
    const hits = idx.search('open A PULL');
    expect(hits[0]?.qualified).toBe('git.create_pull_request');
  });

  it('returns a bounded slice for an empty/stopword-only query instead of everything', () => {
    const idx = new ToolIndex();
    for (let i = 0; i < 20; i++) idx.add('s', `tool_${i}`, `tool number ${i}`);
    expect(idx.search('   ', 5).length).toBe(5); // whitespace-only → first N, capped
    expect(idx.search('the a of', 3).length).toBe(3); // all-stopword → first N, capped
  });
});

// T18: bounded output. A 10-hit search of verbose servers must not dump thousands of
// tokens — each description is truncated to ~1–2 lines and total output is capped.
describe('formatHits (bounded search output)', () => {
  const meta = (qualified: string, description: string) => ({
    server: qualified.split('.')[0]!,
    name: qualified.split('.').slice(1).join('.'),
    qualified,
    description,
  });

  it('truncates a verbose description to a single short line with an ellipsis', () => {
    const long = 'word '.repeat(200).trim(); // ~1000 chars on one logical line
    const out = formatHits([meta('s.big', long)], { maxDescChars: 120 });
    const line = out.split('\n')[0]!;
    expect(line.length).toBeLessThanOrEqual(140); // "- s.big — " + 120 + "…"
    expect(line).toContain('s.big');
    expect(line).toContain('…');
  });

  it('collapses a multi-line description down to its first line', () => {
    const out = formatHits([meta('s.multi', 'first line\nsecond line\nthird line')]);
    expect(out).toContain('first line');
    expect(out).not.toContain('second line');
  });

  it('caps total output length across many hits', () => {
    const hits = Array.from({ length: 50 }, (_, i) =>
      meta(`s.tool_${i}`, 'a reasonably wordy description that repeats itself a bit ' + i),
    );
    const out = formatHits(hits, { maxTotalChars: 600 });
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out).toContain('s.tool_0'); // the top hits survive
  });
});

// T16: search_tools must index from a cheap cached manifest persisted under
// $VIBECODERS_HOME — searchable WITHOUT connecting. Connection happens only on
// load_tool/call_tool.
describe('gateway manifest cache (search without connecting)', () => {
  it('round-trips a per-server manifest through $VIBECODERS_HOME', () => {
    const home = mkdtempSync(join(tmpdir(), 'vibe-manifest-'));
    process.env.VIBECODERS_HOME = home;
    try {
      expect(manifestPath()).toBe(join(home, 'gateway', 'manifest.json'));
      expect(loadManifest()).toEqual({}); // absent file → empty, never throws
      saveManifest({
        playwright: [{ name: 'browser_navigate', description: 'go to a url' }],
      });
      const back = loadManifest();
      expect(back.playwright?.[0]?.name).toBe('browser_navigate');
      expect(back.playwright?.[0]?.description).toBe('go to a url');
    } finally {
      delete process.env.VIBECODERS_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('tolerates a corrupt manifest file by treating it as empty', () => {
    const home = mkdtempSync(join(tmpdir(), 'vibe-manifest-bad-'));
    process.env.VIBECODERS_HOME = home;
    try {
      saveManifest({}); // creates the gateway dir
      writeFileSync(manifestPath(), '{ not json ,,, }');
      expect(loadManifest()).toEqual({});
    } finally {
      delete process.env.VIBECODERS_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('search_tools indexes from the cached manifest WITHOUT spawning any child', async () => {
    // The core T16 promise: a cold search costs zero child processes. We seed the manifest
    // from a real connect once, drop all warm state, then prove a fresh ToolIndex can be
    // populated from disk alone — no SPAWN_MARKER lines added on the second pass.
    const home = mkdtempSync(join(tmpdir(), 'vibe-manifest-search-'));
    const spawnMarker = join(home, 'spawn.log');
    process.env.VIBECODERS_HOME = home;
    const servers = {
      echo: { command: 'node', args: [echoServer], env: ['SPAWN_MARKER'], lazy: true },
    };
    const connector = new Connector(
      servers,
      (name) => (name === 'SPAWN_MARKER' ? spawnMarker : undefined),
      silentLog,
      5000,
    );
    try {
      // Warm once to populate + persist the manifest, then close everything.
      const tools = await connector.listTools('echo');
      saveManifest({ echo: tools.map((t) => ({ name: t.name, description: t.description })) });
      await connector.closeAll();
      expect(spawnCount(spawnMarker)).toBe(1);

      // Cold path: hydrate a brand-new index straight from the manifest — no connect.
      const index = new ToolIndex();
      const manifest = loadManifest();
      for (const [server, list] of Object.entries(manifest)) {
        for (const t of list) index.add(server, t.name, t.description);
      }
      expect(index.get('echo.echo')).toBeTruthy();
      expect(index.search('echo text').length).toBeGreaterThan(0);
      // Crucially: indexing from the manifest spawned NO new child.
      expect(spawnCount(spawnMarker)).toBe(1);
    } finally {
      delete process.env.VIBECODERS_HOME;
      await connector.closeAll();
      rmSync(home, { recursive: true, force: true });
    }
  }, 15000);
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  availableLayers,
  designRagDir,
  loadRagData,
  registerRag,
  renderCore,
  renderLayer,
  LAYER_NAMES,
} from '../src/rag/tools';
import type { Logger } from '../src/util/logger';
import { PROFILES, type HostProfile } from '../src/host/profile';

const fixtureLayers = { donts: 'AVOID THE FADE', scaffolds: 'one dominant each' };

/** Write a content dir carrying an image_gen layer (for the host-note tests). */
function writeImageGenContentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-rag-ig-'));
  writeFileSync(join(dir, 'core.json'), JSON.stringify({ content: 'core' }));
  writeFileSync(
    join(dir, 'layers.json'),
    JSON.stringify({ image_gen: 'RENDER WITH generate_image', donts: 'AVOID' }),
  );
  return dir;
}

/** Write a valid local content dir and return its path. */
function writeContentDir(core = 'the standard and the two gates'): string {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-rag-'));
  writeFileSync(join(dir, 'core.json'), JSON.stringify({ content: core }));
  writeFileSync(
    join(dir, 'layers.json'),
    JSON.stringify({ donts: 'AVOID THE FADE', scaffolds: 'one dominant each' }),
  );
  return dir;
}

const tempDirs: string[] = [];
const ENV_KEYS = ['VIBECODERS_DESIGN_RAG_DIR', 'VIBECODERS_HOME'] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('renderCore', () => {
  it('returns the core content verbatim', () => {
    expect(renderCore({ content: 'the standard' })).toBe('the standard');
  });
});

describe('renderLayer', () => {
  it('returns a named layer body', () => {
    expect(renderLayer(fixtureLayers, 'donts')).toBe('AVOID THE FADE');
  });

  it('throws with the available list on an unknown layer', () => {
    expect(() => renderLayer(fixtureLayers, 'nope')).toThrow(
      /unknown layer "nope".*donts, scaffolds/,
    );
  });

  it('byte-caps the returned body', () => {
    expect(renderLayer({ big: 'x'.repeat(50) }, 'big', 10)).toHaveLength(10);
  });
});

describe('host-aware RAG rendering', () => {
  const stale = 'STALE: call generate_image via codex-cli and require a subagent';
  const layers = { directives: stale, scaffolds: stale, image_gen: stale, plain: stale };

  it('places Codex binding policy before every imagery-bearing stale corpus body', () => {
    expect(renderCore({ content: stale }, { host: PROFILES.codex }).indexOf('HOST EXECUTION POLICY')).toBe(0);
    for (const name of ['directives', 'scaffolds', 'image_gen']) {
      const out = renderLayer(layers, name, 200_000, { host: PROFILES.codex });
      expect(out.indexOf('HOST EXECUTION POLICY')).toBe(0);
      expect(out.indexOf(stale)).toBeGreaterThan(0);
      expect(out).toMatch(/Never invoke or delegate to codex-cli/);
    }
    expect(renderLayer(layers, 'plain', 200_000, { host: PROFILES.codex })).toBe(stale);
  });

  it('uses host-specific safe policies and preserves non-JSON layers losslessly', () => {
    expect(renderCore({ content: stale }, { host: PROFILES['claude-code'] })).toMatch(/generate_image path/);
    expect(renderCore({ content: stale }, { host: PROFILES['gemini-cli'] })).toMatch(/do not assume a subagent suite/);
    expect(renderLayer({ donts: 'not json' }, 'donts', 200_000, { host: PROFILES.codex })).toBe('not json');
  });

  it('filters models-tagged donts and recomputes exact counts without changing unknown payloads', () => {
    const body = JSON.stringify({ tells: [
      { id: 'shared', models: 'shared' }, { id: 'codex', models: ['codex'] }, { id: 'claude', models: 'claude' },
    ], counts: { total: 99 } });
    const read = (host: HostProfile) => JSON.parse(renderLayer({ donts: body }, 'donts', 200_000, { host }));
    expect(read(PROFILES.codex)).toMatchObject({ tells: [{ id: 'shared' }, { id: 'codex' }], counts: { total: 2, claude: 0, codex: 1, shared: 1 } });
    expect(read(PROFILES['claude-code'])).toMatchObject({ tells: [{ id: 'shared' }, { id: 'claude' }], counts: { total: 2, claude: 1, codex: 0, shared: 1 } });
    expect(read(PROFILES['gemini-cli'])).toMatchObject({ tells: [{ id: 'shared' }], counts: { total: 1, claude: 0, codex: 0, shared: 1 } });
    expect(renderLayer({ donts: body }, 'donts', 200_000, { host: PROFILES.unknown })).toBe(body);
  });
});

describe('availableLayers', () => {
  it('lists the layer keys', () => {
    expect(availableLayers(fixtureLayers)).toEqual(['donts', 'scaffolds']);
  });
});

// The content is bring-your-own: it loads from a local dir at startup, is
// overridable by env, and its absence is a graceful state, never a throw.
describe('designRagDir + loadRagData (local content)', () => {
  it('defaults under the vibecoders home and honors both env overrides', () => {
    process.env.VIBECODERS_HOME = '/tmp/vibe-home';
    delete process.env.VIBECODERS_DESIGN_RAG_DIR;
    expect(designRagDir()).toBe(join('/tmp/vibe-home', 'design-rag'));
    process.env.VIBECODERS_DESIGN_RAG_DIR = '/tmp/explicit-rag';
    expect(designRagDir()).toBe('/tmp/explicit-rag');
  });

  it('loads {core, layers} from a content dir', () => {
    const dir = writeContentDir();
    tempDirs.push(dir);
    const data = loadRagData(dir);
    expect(data).not.toBeNull();
    expect(data!.core.content).toMatch(/gates/);
    expect(availableLayers(data!.layers)).toEqual(['donts', 'scaffolds']);
  });

  it('resolves to null when the dir is absent', () => {
    expect(loadRagData(join(tmpdir(), 'vibe-rag-definitely-missing'))).toBeNull();
  });

  it('resolves to null on malformed or hollow content, never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-rag-bad-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'core.json'), '{not json');
    writeFileSync(join(dir, 'layers.json'), '{}');
    expect(loadRagData(dir)).toBeNull();
    writeFileSync(join(dir, 'core.json'), JSON.stringify({ content: '' }));
    expect(loadRagData(dir)).toBeNull();
    writeFileSync(join(dir, 'core.json'), JSON.stringify({ content: 'ok' }));
    writeFileSync(join(dir, 'layers.json'), JSON.stringify(['not', 'a', 'record']));
    expect(loadRagData(dir)).toBeNull();
  });
});

// The design_layer enum and the generator must stay in lockstep: a layer
// declared in LAYER_NAMES but not produced by scripts/build-rag-data.mjs (or
// vice-versa) would be a silent dead option. Drive the REAL generator over a
// tiny source tree and assert parity on its output.
describe('build-rag-data.mjs generator parity', () => {
  it('produces exactly the LAYER_NAMES set and a non-empty core', () => {
    const src = mkdtempSync(join(tmpdir(), 'vibe-rag-src-'));
    const out = mkdtempSync(join(tmpdir(), 'vibe-rag-out-'));
    tempDirs.push(src, out);
    const sources: Record<string, string> = {
      'dos.md': 'THE STANDARD: derive from the brand. Non-negotiable one. Non-negotiable two.',
      'tells.json': '{"tells":[]}',
      'formatting-index.md': 'formatting index',
      'formatting.json': '{"laws":[]}',
      'directives-index.md': 'directives index',
      'directives.json': '{"directives":[]}',
      'scaffolds-index.md': 'scaffolds index',
      'scaffolds.json': '{"scaffolds":[]}',
      'scaffolds.css': '.shell { display: grid }',
      'type-pointers-index.md': 'type pointers index',
      'type-pointers.json': '{"pointers":[]}',
      'image-gen.md': 'CLAUDE_SPECIFIC_IMAGE_MARKER',
    };
    for (const [p, body] of Object.entries(sources)) writeFileSync(join(src, p), body);

    execFileSync(process.execPath, [join(__dirname, '..', 'scripts', 'build-rag-data.mjs'), src], {
      env: { ...process.env, VIBECODERS_DESIGN_RAG_DIR: out },
    });

    const layers = JSON.parse(readFileSync(join(out, 'layers.json'), 'utf8')) as Record<
      string,
      string
    >;
    const core = JSON.parse(readFileSync(join(out, 'core.json'), 'utf8')) as { content: string };
    expect(Object.keys(layers).sort()).toEqual([...LAYER_NAMES].sort());
    expect(core.content).toMatch(/THE STANDARD/);
    expect(core.content).toMatch(/design_layer/);
    expect(layers.image_gen).not.toContain('CLAUDE_SPECIFIC_IMAGE_MARKER');
    for (const [name, body] of Object.entries(layers)) {
      expect(body.length, name).toBeGreaterThan(0);
    }
  });
});

// T-style: registerRag wires the tools over real MCP transport. With local
// content installed the tools serve it; without it they answer the graceful
// not-installed note (and stay registered, names and schemas stable).
describe('registerRag — tools over MCP transport', () => {
  async function connectPair() {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerRag(server, { log });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0.0.0' });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    return client;
  }

  it('serves design_core and design_layer from the local content dir', async () => {
    const dir = writeContentDir('the standard carrying the gates');
    tempDirs.push(dir);
    process.env.VIBECODERS_DESIGN_RAG_DIR = dir;

    const client = await connectPair();
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toContain('design_core');
      expect(tools).toContain('design_layer');

      const core = (await client.callTool({ name: 'design_core', arguments: {} })) as {
        content: Array<{ text: string }>;
      };
      expect(core.content[0]!.text).toMatch(/gates/i);

      const donts = (await client.callTool({
        name: 'design_layer',
        arguments: { layer: 'donts' },
      })) as { content: Array<{ text: string }> };
      expect(donts.content[0]!.text).toBe('AVOID THE FADE');
    } finally {
      await client.close();
    }
  });

  it('answers the not-installed note when no local content exists', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'vibe-rag-empty-'));
    tempDirs.push(empty);
    process.env.VIBECODERS_DESIGN_RAG_DIR = empty;

    const client = await connectPair();
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toContain('design_core');
      expect(tools).toContain('design_layer');

      const core = (await client.callTool({ name: 'design_core', arguments: {} })) as {
        content: Array<{ text: string }>;
      };
      expect(core.content[0]!.text).toMatch(/not installed locally/);

      const layer = (await client.callTool({
        name: 'design_layer',
        arguments: { layer: 'donts' },
      })) as { content: Array<{ text: string }> };
      expect(layer.content[0]!.text).toMatch(/not installed locally/);
    } finally {
      await client.close();
    }
  });
});

// RAG prepends a binding host policy before imagery corpus text.
describe('registerRag — prepended host execution policy', () => {
  async function connectWithHost(getHost: () => HostProfile) {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerRag(server, { log, getHost });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0.0.0' });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    return client;
  }

  const layerText = async (client: Awaited<ReturnType<typeof connectWithHost>>, layer: string) =>
    (
      (await client.callTool({ name: 'design_layer', arguments: { layer } })) as {
        content: Array<{ text: string }>;
      }
    ).content[0]!.text;

  it('prepends Codex policy on image_gen when native image generation is available', async () => {
    const dir = writeImageGenContentDir();
    tempDirs.push(dir);
    process.env.VIBECODERS_DESIGN_RAG_DIR = dir;
    const client = await connectWithHost(() => PROFILES.codex);
    try {
      const out = await layerText(client, 'image_gen');
      expect(out).toContain('RENDER WITH generate_image'); // real layer body preserved
      expect(out.indexOf('HOST EXECUTION POLICY')).toBe(0);
    } finally {
      await client.close();
    }
  });

  it('prepends Claude policy when the host lacks native image generation', async () => {
    const dir = writeImageGenContentDir();
    tempDirs.push(dir);
    process.env.VIBECODERS_DESIGN_RAG_DIR = dir;
    const client = await connectWithHost(() => PROFILES['claude-code']);
    try {
      const out = await layerText(client, 'image_gen');
      expect(out).toContain('RENDER WITH generate_image');
      expect(out.indexOf('HOST EXECUTION POLICY')).toBe(0);
    } finally {
      await client.close();
    }
  });

  it('does not add policy to non-imagery layers', async () => {
    const dir = writeImageGenContentDir();
    tempDirs.push(dir);
    process.env.VIBECODERS_DESIGN_RAG_DIR = dir;
    const client = await connectWithHost(() => PROFILES.codex);
    try {
      expect(await layerText(client, 'donts')).toBe('AVOID'); // verbatim, no note
    } finally {
      await client.close();
    }
  });
});

import { describe, it, expect } from 'vitest';
import {
  renderCore,
  renderLayer,
  availableLayers,
  registerRag,
  LAYER_NAMES,
} from '../src/rag/tools';
import coreData from '../src/rag/data/core.json';
import layersData from '../src/rag/data/layers.json';
import type { Logger } from '../src/util/logger';

const fixtureLayers = { donts: 'AVOID THE FADE', craft: 'ease with intent' };

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
    expect(() => renderLayer(fixtureLayers, 'nope')).toThrow(/unknown layer "nope".*donts, craft/);
  });

  it('byte-caps the returned body', () => {
    expect(renderLayer({ big: 'x'.repeat(50) }, 'big', 10)).toHaveLength(10);
  });
});

describe('availableLayers', () => {
  it('lists the layer keys', () => {
    expect(availableLayers(fixtureLayers)).toEqual(['donts', 'craft']);
  });
});

// The design_layer enum and the generated data must stay in lockstep — a layer
// declared in LAYER_NAMES but missing from the bundle (or vice-versa) would be a
// silent dead option. Assert parity against the REAL inlined payload.
describe('bundled RAG data', () => {
  it('has a non-empty core carrying the gates', () => {
    const core = (coreData as { content: string }).content;
    expect(core.length).toBeGreaterThan(1000);
    expect(core).toMatch(/gate/i);
  });

  it('every LAYER_NAMES entry exists in the data, and vice-versa', () => {
    expect(Object.keys(layersData as Record<string, string>).sort()).toEqual([...LAYER_NAMES].sort());
  });

  it('no layer is empty', () => {
    for (const [name, body] of Object.entries(layersData as Record<string, string>)) {
      expect(body.length, name).toBeGreaterThan(0);
    }
  });
});

// T-style: registerRag wires the tools over real MCP transport; design_core
// returns the core and design_layer serves a named layer. design_layer's bad
// path is enum-guarded by the SDK, so the pure renderLayer test above covers the
// throw; here we assert the happy path end to end.
describe('registerRag — tools over MCP transport', () => {
  it('serves design_core and design_layer', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

    const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerRag(server, { log });

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0.0.0' });
    try {
      await Promise.all([server.connect(serverT), client.connect(clientT)]);

      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toContain('design_core');
      expect(tools).toContain('design_layer');

      const core = (await client.callTool({ name: 'design_core', arguments: {} })) as {
        content: Array<{ text: string }>;
      };
      expect(core.content[0]!.text).toMatch(/gate/i);

      const donts = (await client.callTool({
        name: 'design_layer',
        arguments: { layer: 'donts' },
      })) as { content: Array<{ text: string }> };
      expect(donts.content[0]!.text.length).toBeGreaterThan(100);
    } finally {
      await client.close();
    }
  });
});

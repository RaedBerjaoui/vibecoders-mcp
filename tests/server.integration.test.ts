import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const pkgVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
).version as string;

const textOf = (res: unknown): string =>
  ((res as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('\n');

describe('vibecoders server (end-to-end over stdio)', () => {
  it('starts, completes the MCP handshake, and exposes its tools', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vibe-home-'));
    const transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath],
      env: { ...process.env, VIBECODERS_LOG_LEVEL: 'error', VIBECODERS_HOME: home } as Record<string, string>,
    });
    const client = new Client({ name: 'integration-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain('doctor');
      expect(names).toContain('search_tools');
      expect(names).toContain('load_tool');
      expect(names).toContain('call_tool');
      expect(names).toContain('write_handoff');
      expect(names).toContain('recall_handoff');
      // CLI-delegation tools (optional capability, always registered).
      expect(names).toContain('list_providers');
      expect(names).toContain('delegate');
      // Capability tools (fail-closed at call time, but always exposed).
      expect(names).toContain('generate_image');
      expect(names).toContain('web_search');
      // Memory-graph RAG (on by default; lexical with no keys).
      expect(names).toContain('memory_store');
      expect(names).toContain('memory_recall');
      expect(names).toContain('memory_walk');
      expect(names).toContain('memory_forget');
      // Orientation.
      expect(names).toContain('project_context');
      // Reference (URL-study) tools.
      expect(names).toContain('reference_inspect');
      expect(names).toContain('reference_excerpt');
      expect(names).toContain('reference_read_source');
      // Background-delegation management (tasks feature, on by default).
      expect(names).toContain('tasks_list');
      expect(names).toContain('tasks_steer');
      expect(names).toContain('tasks_interrupt');
      // Opt-in groups (device/vault) are OFF by default, so they must NOT appear.
      expect(names).not.toContain('device_search');
      expect(names).not.toContain('vault_search');

      // The server advertises how to use itself (search→load→call, delegate, lanes).
      const info = client.getInstructions();
      expect(info).toMatch(/search_tools/);
      expect(info).toMatch(/delegate/);

      // Behavioral: memory store → recall round-trips (lexical, no keys needed).
      await client.callTool({
        name: 'memory_store',
        arguments: { text: 'Redis cache uses LRU eviction for hot keys', id: 'redis-note', scope: 'global' },
      });
      const recall = textOf(await client.callTool({ name: 'memory_recall', arguments: { query: 'redis cache eviction' } }));
      expect(recall).toMatch(/redis-note/);
      expect(recall).toMatch(/LRU eviction/);

      // Behavioral: doctor and project_context produce real content. The doctor
      // now renders via the shared renderer (T28) with the T34 legend + T32 words.
      const doctor = textOf(await client.callTool({ name: 'doctor', arguments: {} }));
      expect(doctor).toMatch(/Memory:/);
      expect(doctor).toMatch(/Tool groups \(features\.\* toggle/); // T34 legend wording
      expect(doctor).toMatch(/Capabilities \(configure a provider\)/); // T34 legend line
      expect(doctor).toMatch(/Disabled \(device, vault\)/); // opt-in groups advertise how to enable
      expect(doctor).toContain('Private overlay:');

      // T32 — structured doctor output is scriptable and JSON-parseable.
      const doctorJson = textOf(await client.callTool({ name: 'doctor', arguments: { json: true } }));
      const parsed = JSON.parse(doctorJson);
      expect(Array.isArray(parsed.capabilities)).toBe(true);
      expect(parsed).toHaveProperty('configured');
      expect(parsed.toolGroups.find((g: { name: string }) => g.name === 'memory')).toBeTruthy();
      const ctx = textOf(await client.callTool({ name: 'project_context', arguments: {} }));
      expect(ctx).toMatch(/Project context/);
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);

  it('adapts the initialize instructions to the driving client (clientInfo → Codex)', async () => {
    // End-to-end proof that the initialize override delegates to the SDK's
    // _oninitialize (so clientInfo is stored) AND rewrites the instructions per
    // host: a client that names itself codex-* gets the OpenAI Codex surface.
    const home = mkdtempSync(join(tmpdir(), 'vibe-home-'));
    const transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath],
      env: { ...process.env, VIBECODERS_LOG_LEVEL: 'error', VIBECODERS_HOME: home } as Record<string, string>,
    });
    // A Codex-family client name (matched loosely, case-insensitively).
    const client = new Client({ name: 'codex-mcp-client', version: '0.0.0' });
    try {
      await client.connect(transport);
      const info = client.getInstructions();
      expect(info).toContain('Driving client: OpenAI Codex');
    } finally {
      await client.close().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);

  it('reports the package.json version in its MCP handshake (single source of truth)', async () => {
    // The handshake version must track package.json — not a hand-kept literal that drifts.
    const home = mkdtempSync(join(tmpdir(), 'vibe-home-'));
    const transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath],
      env: { ...process.env, VIBECODERS_LOG_LEVEL: 'error', VIBECODERS_HOME: home } as Record<string, string>,
    });
    const client = new Client({ name: 'integration-test', version: '0.0.0' });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.version).toBe(pkgVersion);
    } finally {
      await client.close().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);

  it('boots as a self-contained bundle from a clone with no resolvable node_modules', async () => {
    // Simulates the Claude Code plugin / marketplace path: dist/index.js is cloned to
    // a directory with NO node_modules up the tree and NO `npm install` step. A bundled
    // artifact still boots; an externals build dies with ERR_MODULE_NOT_FOUND on
    // @modelcontextprotocol/sdk before the handshake. cwd is set into the isolated dir
    // so neither file-relative ESM resolution nor cwd can reach the repo's node_modules.
    const clone = mkdtempSync(join(tmpdir(), 'vibe-plugin-'));
    const cloneServer = join(clone, 'index.js');
    copyFileSync(serverPath, cloneServer);
    const home = mkdtempSync(join(tmpdir(), 'vibe-home-'));
    const transport = new StdioClientTransport({
      command: 'node',
      args: [cloneServer],
      cwd: clone,
      env: { ...process.env, VIBECODERS_LOG_LEVEL: 'error', VIBECODERS_HOME: home } as Record<string, string>,
    });
    const client = new Client({ name: 'integration-test', version: '0.0.0' });
    try {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('doctor');
      expect(names).toContain('search_tools');
      expect(names).toContain('delegate');
    } finally {
      await client.close().catch(() => {});
      rmSync(clone, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);

  it('search → load → call round-trips against a real mounted downstream server', async () => {
    // T36: the flagship gateway path, e2e. Mount a tiny stdio MCP fixture via
    // VIBECODERS_SERVERS, then drive it through the three meta-tools exactly as the model
    // would: discover its tool, fetch the input schema, call it, and confirm an unknown
    // qualified id is rejected with the actionable "Add it to servers.json" hint.
    const home = mkdtempSync(join(tmpdir(), 'vibe-home-'));
    const echoServer = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));
    const serversFile = join(home, 'servers.json');
    writeFileSync(
      serversFile,
      JSON.stringify({ servers: { echo: { command: 'node', args: [echoServer] } } }),
    );
    const transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath],
      env: {
        ...process.env,
        VIBECODERS_LOG_LEVEL: 'error',
        VIBECODERS_HOME: home,
        VIBECODERS_SERVERS: serversFile,
      } as Record<string, string>,
    });
    const client = new Client({ name: 'integration-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      // search_tools finds the fixture's `echo` tool by plain-language query.
      const found = textOf(
        await client.callTool({ name: 'search_tools', arguments: { query: 'echo text back' } }),
      );
      expect(found).toContain('echo.echo');

      // load_tool returns the full input schema (served from the Connector's cache after T17).
      const loaded = textOf(
        await client.callTool({ name: 'load_tool', arguments: { id: 'echo.echo' } }),
      );
      const schema = JSON.parse(loaded);
      expect(schema.id).toBe('echo.echo');
      expect(schema.inputSchema?.properties?.text).toBeTruthy(); // the fixture's `text` param

      // call_tool round-trips through the live child.
      const called = textOf(
        await client.callTool({
          name: 'call_tool',
          arguments: { id: 'echo.echo', args: { text: 'ping' } },
        }),
      );
      expect(called).toContain('echo: ping');

      // An unknown server id is rejected with the actionable hint, not a silent failure.
      const bad = textOf(
        await client.callTool({ name: 'call_tool', arguments: { id: 'nope.whatever', args: {} } }),
      );
      expect(bad).toContain('Add it to servers.json');
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);

  it('exposes opt-in device/vault tools only when enabled in config', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vibe-home-'));
    const cfgPath = join(home, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ features: { device: true, vault: true } }));
    const transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath],
      env: {
        ...process.env,
        VIBECODERS_LOG_LEVEL: 'error',
        VIBECODERS_HOME: home,
        VIBECODERS_CONFIG: cfgPath,
      } as Record<string, string>,
    });
    const client = new Client({ name: 'integration-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('device_search');
      expect(names).toContain('chat_history_search');
      expect(names).toContain('vault_search');
      expect(names).toContain('vault_read');
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});

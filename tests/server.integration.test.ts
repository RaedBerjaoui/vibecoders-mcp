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

/**
 * Boot one fresh server over stdio under a given Client name/env/config, run the
 * assertions, then always close the client and delete its tmp home — the same
 * connect/close discipline the inline tests use, centralized so each host-matrix
 * case is one cheap boot with no hanging handles. When `config` is given it is
 * written to `$VIBECODERS_HOME/config.json` (the resolution path loadVibeConfig
 * falls back to when VIBECODERS_CONFIG is unset), so we drop any ambient pin.
 */
async function withClient(
  opts: { name: string; env?: Record<string, string>; config?: unknown },
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'vibe-home-'));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    VIBECODERS_LOG_LEVEL: 'error',
    VIBECODERS_HOME: home,
    ...opts.env,
  };
  if (opts.config !== undefined) {
    writeFileSync(join(home, 'config.json'), JSON.stringify(opts.config));
    delete env.VIBECODERS_CONFIG; // force resolution to $VIBECODERS_HOME/config.json
  }
  const transport = new StdioClientTransport({ command: 'node', args: [serverPath], env });
  const client = new Client({ name: opts.name, version: '0.0.0' });
  try {
    await client.connect(transport);
    await fn(client);
  } finally {
    await client.close().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
}

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
      expect(info).not.toMatch(/search_tools/); // no downstream servers are mounted
      expect(info).toMatch(/delegate/);
      // Host matrix (unknown client): 'integration-test' matches no host family, so
      // the instructions carry NO "Driving client:" line (that's added only for a
      // recognized host).
      expect(info).not.toContain('Driving client:');

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
      // Host matrix (unknown client): the driver is labeled generically, with no
      // (detected)/(pinned) suffix (source is 'default').
      expect(doctor).toContain('driver: this MCP client');

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

  it('host matrix: Codex client (clientInfo) — instructions, tools, doctor, annotations, skill_load', async () => {
    // End-to-end proof that the initialize override delegates to the SDK's
    // _oninitialize (so clientInfo is stored) AND adapts per host: a client that
    // names itself codex-* gets the OpenAI Codex surface, visible on every wire.
    await withClient({ name: 'codex-mcp-client' }, async (client) => {
      // (a) The instructions name the driving client as OpenAI Codex.
      const info = client.getInstructions() ?? '';
      expect(info).toContain('Driving client: OpenAI Codex');
      // (b) The dense first-512-char core (all Codex reliably reads) leads with design_core.
      expect(info.slice(0, 512)).toContain('design_core');
      // (c) The skills group is exposed (on by default; never hidden under Codex).
      const tools = (await client.listTools()).tools;
      const names = tools.map((t) => t.name);
      expect(names).not.toContain('generate_image');
      expect(names).not.toContain('web_search');
      expect(names).toContain('skill_list');
      expect(names).toContain('skill_load');
      // (d) doctor reports Codex as the DETECTED driver (from the clientInfo handshake).
      const doctor = textOf(await client.callTool({ name: 'doctor', arguments: {} }));
      expect(doctor).toContain('driver: OpenAI Codex (detected)');
      // (e) MCP annotations survive the wire (the tools/list `annotations` field):
      //     read-only doctor, destructive tasks_interrupt.
      expect(tools.find((t) => t.name === 'doctor')?.annotations?.readOnlyHint).toBe(true);
      expect(tools.find((t) => t.name === 'tasks_interrupt')?.annotations?.destructiveHint).toBe(true);
      // Case 5 — skill_load under Codex returns the playbook body (Credits:) plus the
      //     Codex tool-name appendix (apply_patch).
      const skill = textOf(
        await client.callTool({ name: 'skill_load', arguments: { name: 'debugging' } }),
      );
      expect(skill).toContain('Credits:');
      expect(skill).toContain('apply_patch');
    });
  }, 20000);

  it('host matrix: Claude Code client (clientInfo) — instructions, generate_image, doctor, skill_load', async () => {
    await withClient({ name: 'claude-code' }, async (client) => {
      // Instructions name Claude Code as the driver.
      expect(client.getInstructions()).toContain('Driving client: Claude Code');
      // Claude Code has no native image generation, so generate_image is never hidden
      // (this box has the codex CLI on PATH, so image_gen resolves and the tool stays).
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('generate_image');
      // doctor reports Claude Code as the DETECTED driver.
      const doctor = textOf(await client.callTool({ name: 'doctor', arguments: {} }));
      expect(doctor).toContain('driver: Claude Code (detected)');
      // Case 5 — skill_load under Claude Code carries the Claude tool-name appendix
      //     (TodoWrite), NOT the Codex one (apply_patch).
      const skill = textOf(
        await client.callTool({ name: 'skill_load', arguments: { name: 'debugging' } }),
      );
      expect(skill).toContain('TodoWrite');
      expect(skill).not.toContain('apply_patch');
    });
  }, 20000);

  it('host matrix: env VIBECODERS_CLIENT pins the driver over clientInfo (Codex pinned)', async () => {
    // Precedence: the env override outranks the handshake. The client NAMES itself
    // claude-code, but VIBECODERS_CLIENT=codex pins Codex — reported as (pinned).
    await withClient(
      { name: 'claude-code', env: { VIBECODERS_CLIENT: 'codex' } },
      async (client) => {
        const doctor = textOf(await client.callTool({ name: 'doctor', arguments: {} }));
        expect(doctor).toContain('driver: OpenAI Codex (pinned)');
      },
    );
  }, 20000);

  it('host matrix: config host.force pins the driver over clientInfo (Gemini pinned)', async () => {
    // Precedence: config force is the top signal. $VIBECODERS_HOME/config.json with
    // host.force:"gemini" wins even though the client names itself codex-mcp-client.
    await withClient(
      { name: 'codex-mcp-client', config: { host: { force: 'gemini' } } },
      async (client) => {
        const doctor = textOf(await client.callTool({ name: 'doctor', arguments: {} }));
        expect(doctor).toContain('driver: Google Gemini CLI (pinned)');
      },
    );
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

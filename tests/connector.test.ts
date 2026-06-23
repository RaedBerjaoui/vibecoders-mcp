import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connector } from '../src/gateway/connector';
import type { Logger } from '../src/util/logger';

const silentLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const echoServer = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));

/** Count lines a marker file accumulated (one per spawn, or one per tools/list RPC). */
const markerLines = (marker: string): number =>
  existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).length : 0;
const spawnCount = markerLines;
const listCount = markerLines;

describe('Connector timeout guard', () => {
  it('rejects (instead of hanging) when a downstream never completes the handshake', async () => {
    // Spawns a real child that just idles — it never speaks MCP, so without a
    // timeout the gateway would block forever.
    const servers = {
      hang: { command: 'node', args: ['-e', 'setTimeout(() => {}, 4000)'], env: [], lazy: true },
    };
    const connector = new Connector(servers, () => undefined, silentLog, 500);
    const started = Date.now();
    await expect(connector.listTools('hang')).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(3000);
    await connector.closeAll();
  }, 8000);
});

describe('Connector connection lifecycle', () => {
  it('shares one in-flight connect across concurrent first-use calls (no double-spawn)', async () => {
    // Claude Code batches tool calls, so two first-use calls hit connect() concurrently.
    // The old read-then-set-after-await left both missing the cache: both spawned a child,
    // and the 2nd set() orphaned the 1st (closeAll never closed it → leaked child).
    const dir = mkdtempSync(join(tmpdir(), 'vibe-spawn-'));
    const marker = join(dir, 'spawns.log');
    const servers = {
      echo: { command: 'node', args: [echoServer], env: ['SPAWN_MARKER'], lazy: true },
    };
    const connector = new Connector(
      servers,
      (name) => (name === 'SPAWN_MARKER' ? marker : undefined),
      silentLog,
      5000,
    );
    try {
      const [a, b] = await Promise.all([connector.listTools('echo'), connector.listTools('echo')]);
      expect(a.map((t) => t.name)).toContain('echo');
      expect(b.map((t) => t.name)).toContain('echo');
      expect(spawnCount(marker)).toBe(1); // shared connect → exactly one child
    } finally {
      await connector.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  it('evicts a dead downstream and reconnects on the next call (self-heal)', async () => {
    // A cached client kept for process life means a crashed/idle-exited child fails
    // EVERY later call until restart. The connection must self-heal on transport close.
    const dir = mkdtempSync(join(tmpdir(), 'vibe-heal-'));
    const marker = join(dir, 'spawns.log');
    const servers = {
      echo: { command: 'node', args: [echoServer], env: ['SPAWN_MARKER'], lazy: true },
    };
    const connector = new Connector(
      servers,
      (name) => (name === 'SPAWN_MARKER' ? marker : undefined),
      silentLog,
      5000,
    );
    try {
      await connector.listTools('echo'); // spawn #1
      expect(spawnCount(marker)).toBe(1);
      await connector.callTool('echo', 'die', {}); // child responds, then exits
      await new Promise((r) => setTimeout(r, 600)); // let it exit + onclose evict
      const tools = await connector.listTools('echo'); // must reconnect, not fail forever
      expect(tools.map((t) => t.name)).toContain('echo');
      expect(spawnCount(marker)).toBe(2); // a fresh child was spawned
    } finally {
      await connector.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  it('caches the downstream tool list and re-lists only after the connection drops', async () => {
    // load_tool used to re-list on every call; a warm tool list should be a memory lookup,
    // and must be dropped on disconnect so a restarted downstream is re-listed fresh.
    const dir = mkdtempSync(join(tmpdir(), 'vibe-cache-'));
    const listMarker = join(dir, 'list.log');
    const servers = {
      echo: { command: 'node', args: [echoServer], env: ['LIST_MARKER'], lazy: true },
    };
    const connector = new Connector(
      servers,
      (name) => (name === 'LIST_MARKER' ? listMarker : undefined),
      silentLog,
      5000,
    );
    try {
      await connector.listTools('echo'); // tools/list RPC #1
      await connector.listTools('echo'); // served from cache — no RPC
      expect(listCount(listMarker)).toBe(1);
      await connector.callTool('echo', 'die', {}); // child exits → evict + drop cache
      await new Promise((r) => setTimeout(r, 600));
      const tools = await connector.listTools('echo'); // reconnect → fresh RPC #2
      expect(tools.map((t) => t.name)).toContain('echo');
      expect(listCount(listMarker)).toBe(2);
    } finally {
      await connector.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  it('evicts an idle connection after the TTL and reconnects on the next call', async () => {
    // A long session shouldn't hold one idle child per mounted server forever. After the
    // idle TTL elapses with no calls, the warm connection is closed; the next call reconnects.
    const dir = mkdtempSync(join(tmpdir(), 'vibe-idle-'));
    const marker = join(dir, 'spawns.log');
    const idleTtlMs = 300;
    const servers = {
      echo: { command: 'node', args: [echoServer], env: ['SPAWN_MARKER'], lazy: true },
    };
    const connector = new Connector(
      servers,
      (name) => (name === 'SPAWN_MARKER' ? marker : undefined),
      silentLog,
      5000,
      idleTtlMs,
    );
    try {
      await connector.listTools('echo'); // spawn #1
      expect(spawnCount(marker)).toBe(1);
      await new Promise((r) => setTimeout(r, idleTtlMs + 400)); // sit idle past the TTL
      const tools = await connector.listTools('echo'); // idle child was closed → reconnect
      expect(tools.map((t) => t.name)).toContain('echo');
      expect(spawnCount(marker)).toBe(2); // a fresh child proves the idle one was evicted
    } finally {
      await connector.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});

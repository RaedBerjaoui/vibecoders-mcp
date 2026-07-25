import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ServerDef } from './registry';
import type { Logger } from '../util/logger';
import { withTimeout } from '../util/timeout';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Default wall-clock budget for any single downstream operation (ms). */
export const DEFAULT_DOWNSTREAM_TIMEOUT_MS = 60_000;

/** Default idle budget before a warm-but-unused downstream connection is closed (ms). */
export const DEFAULT_IDLE_TTL_MS = 5 * 60_000;

export interface DownstreamTool {
  name: string;
  description: string;
  inputSchema: unknown;
  title?: string;
  outputSchema?: unknown;
  annotations?: unknown;
  [key: string]: unknown;
}

/**
 * Manages live connections to downstream MCP servers. Connects lazily (on first
 * use) and keeps each connection warm. Each server's declared env-var names are
 * resolved from the provided secret source and merged onto a safe default
 * environment — values never touch the repo, and missing ones are warned, not
 * silently dropped.
 */
export class Connector {
  /** server → in-flight-or-resolved connect. Memoized so concurrent callers share one. */
  private clients = new Map<string, Promise<Client>>();
  /** server → its tool list, cached until the connection drops (search_tools + load_tool reuse it). */
  private toolCache = new Map<string, DownstreamTool[]>();
  /** server → pending idle-eviction timer; reset on every use, fires after idleTtlMs of silence. */
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly servers: Record<string, ServerDef>,
    private readonly resolveEnv: (name: string) => string | undefined,
    private readonly log: Logger,
    private readonly timeoutMs: number = DEFAULT_DOWNSTREAM_TIMEOUT_MS,
    /** Close a warm connection after this many ms with no calls (0 disables). Frees idle children. */
    private readonly idleTtlMs: number = DEFAULT_IDLE_TTL_MS,
  ) {}

  has(server: string): boolean {
    return server in this.servers;
  }

  private connect(server: string): Promise<Client> {
    const existing = this.clients.get(server);
    if (existing) return existing;

    const def = this.servers[server];
    if (!def) {
      return Promise.reject(new Error(`Unknown server "${server}". Add it to servers.json.`));
    }

    // Memoize the in-flight promise synchronously — BEFORE any await — so two concurrent
    // first-use callers share one connect instead of each spawning (and orphaning) a child.
    // `evict` removes this connection iff it's still the cached one (not a newer reconnect).
    let pending: Promise<Client>;
    const evict = (reason: string) => {
      if (this.clients.get(server) === pending) {
        this.clients.delete(server);
        this.toolCache.delete(server); // drop the cached tool list so a reconnect re-lists fresh
        this.clearIdle(server); // the connection is gone — no idle timer left to fire
        this.log.warn(`downstream "${server}" ${reason} — evicted; will reconnect on next use`);
      }
    };
    pending = this.dial(server, def, () => evict('disconnected'));
    this.clients.set(server, pending);
    pending.catch(() => evict('failed to connect'));
    return pending;
  }

  private async dial(server: string, def: ServerDef, onClose: () => void): Promise<Client> {
    const env: Record<string, string> = { ...getDefaultEnvironment() };
    for (const name of def.env) {
      const value = this.resolveEnv(name);
      if (value) env[name] = value;
      else this.log.warn(`server "${server}" expects env ${name}, but it is not set`);
    }

    const transport = new StdioClientTransport({
      command: def.command,
      args: def.args,
      env,
    });
    const client = new Client({ name: 'vibecoders-gateway', version: '0.1.0' });
    // Self-heal: when the child dies (crash/OOM/idle-exit), the transport closes and the
    // SDK fires client.onclose — evict the cached connection so the next call reconnects.
    client.onclose = onClose;
    try {
      await withTimeout(client.connect(transport), this.timeoutMs, `connecting to "${server}"`);
    } catch (e) {
      // Don't leave a zombie child if the handshake hangs or fails. Failure eviction is
      // handled by connect()'s pending.catch, so detach onclose to avoid a double-evict.
      client.onclose = undefined;
      await transport.close().catch(() => {});
      throw e;
    }
    this.log.info(`mounted downstream server "${server}"`);
    return client;
  }

  async listTools(server: string): Promise<DownstreamTool[]> {
    // Warm path: a memory lookup. search_tools indexes from this and load_tool reads the
    // schema back out of it, so neither pays a second tools/list RPC. Dropped on disconnect.
    const cached = this.toolCache.get(server);
    if (cached) {
      this.touch(server);
      return cached;
    }
    const client = await this.connect(server);
    const res = await withTimeout(
      client.listTools(),
      this.timeoutMs,
      `listing tools on "${server}"`,
    );
    const tools = res.tools.map((t) => ({ ...t, description: t.description ?? '' }));
    this.toolCache.set(server, tools);
    this.touch(server);
    return tools;
  }

  async callTool(
    server: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const client = await this.connect(server);
    this.touch(server);
    // Pass the budget to the SDK so it also cancels the in-flight request, and
    // race it ourselves so a transport that never settles can't wedge the call.
    return (await withTimeout(
      client.callTool({ name, arguments: args }, undefined, { timeout: this.timeoutMs }),
      this.timeoutMs,
      `calling "${server}.${name}"`,
    )) as CallToolResult;
  }

  /** Reset a server's idle timer; after idleTtlMs of no calls, close its warm child. */
  private touch(server: string): void {
    if (this.idleTtlMs <= 0) return; // idle-eviction disabled
    this.clearIdle(server);
    const timer = setTimeout(() => void this.evictIdle(server), this.idleTtlMs);
    timer.unref?.(); // never keep the process alive just to evict an idle connection
    this.idleTimers.set(server, timer);
  }

  private clearIdle(server: string): void {
    const timer = this.idleTimers.get(server);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(server);
    }
  }

  /** Close + forget a connection that has sat unused past its TTL, freeing the child process. */
  private async evictIdle(server: string): Promise<void> {
    const pending = this.clients.get(server);
    this.clients.delete(server);
    this.toolCache.delete(server);
    this.idleTimers.delete(server);
    if (!pending) return;
    this.log.info(`downstream "${server}" idle > ${this.idleTtlMs}ms — closing to free the child`);
    try {
      await (await pending).close();
    } catch {
      // a still-connecting or already-dead client — nothing to close
    }
  }

  async closeAll(): Promise<void> {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    const pending = [...this.clients.entries()];
    this.clients.clear();
    this.toolCache.clear();
    for (const [name, clientPromise] of pending) {
      try {
        // Await the in-flight connect first so we never orphan a still-connecting child;
        // a rejected promise (failed connect) lands in catch and is logged, not thrown.
        await (await clientPromise).close();
      } catch (e) {
        this.log.warn(`error closing "${name}"`, e);
      }
    }
  }
}

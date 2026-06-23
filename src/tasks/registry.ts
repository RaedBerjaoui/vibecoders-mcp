/**
 * In-memory, session-scoped registry of background delegations. A vibecoders MCP
 * server is one long-running process, so a background task is just a child of
 * that process tracked here — it lives as long as the session and is cleaned up
 * when the server exits. Reuses `startDelegate` so a background task and a
 * synchronous `delegate` build/spawn/parse identically.
 *
 * Never throws: management calls return `{ ok, message }`. Output is capped so a
 * runaway delegate can't grow memory without bound.
 */
import { spawn } from 'node:child_process';
import {
  startDelegate,
  type DelegateOptions,
  type DelegateResult,
  type StartedDelegate,
} from '../providers/delegate';
import type { ProviderDef } from '../providers/registry';

export type TaskStatus = 'running' | 'done' | 'failed' | 'interrupted';

export interface TaskRecord {
  id: string;
  /** Provider id (codex/gemini/claude). */
  provider: string;
  mode: 'read' | 'write';
  status: TaskStatus;
  startedAt: number;
  endedAt?: number;
  /** Live stream while running; the final clean answer (or error) once settled. */
  output: string;
  /** First ~120 chars of the prompt, for at-a-glance identification. */
  promptPreview: string;
}

export interface TaskRegistry {
  start(def: ProviderDef, prompt: string, opts?: DelegateOptions): string;
  list(): TaskRecord[];
  get(id: string): TaskRecord | undefined;
  steer(id: string, input: string): { ok: boolean; message: string };
  interrupt(id: string): { ok: boolean; message: string };
  /** Resolves once the task settles. Primarily a test/await helper. */
  whenSettled(id: string): Promise<void>;
}

export interface TaskRegistryOptions {
  spawnFn?: typeof spawn;
  now?: () => number;
  idGen?: () => string;
  /** Hard cap on retained output per task (default 200_000 chars). */
  maxOutput?: number;
}

interface Entry {
  rec: TaskRecord;
  handle: StartedDelegate;
}

export function createTaskRegistry(opts: TaskRegistryOptions = {}): TaskRegistry {
  const spawnFn = opts.spawnFn ?? spawn;
  const now = opts.now ?? (() => Date.now());
  const maxOutput = opts.maxOutput ?? 200_000;
  let counter = 0;
  const idGen = opts.idGen ?? (() => `t_${(++counter).toString(36)}`);

  const entries = new Map<string, Entry>();
  const order: string[] = []; // insertion order (oldest → newest)

  const cap = (s: string): string => (s.length > maxOutput ? s.slice(-maxOutput) : s);

  /** A copy with live output spliced in while running. */
  const snapshot = (e: Entry): TaskRecord =>
    e.rec.status === 'running' ? { ...e.rec, output: cap(e.handle.peek()) } : { ...e.rec };

  function start(def: ProviderDef, prompt: string, dopts: DelegateOptions = {}): string {
    const id = idGen();
    const rec: TaskRecord = {
      id,
      provider: def.id,
      mode: dopts.mode ?? 'read',
      status: 'running',
      startedAt: now(),
      output: '',
      promptPreview: prompt.slice(0, 120),
    };
    const handle = startDelegate(def, prompt, dopts, spawnFn);
    entries.set(id, { rec, handle });
    order.push(id);
    handle.done.then((res: DelegateResult) => {
      rec.endedAt = now();
      rec.output = cap(res.output);
      // interrupt() sets the status first; never overwrite that signal.
      if (rec.status !== 'interrupted') rec.status = res.ok ? 'done' : 'failed';
    });
    return id;
  }

  return {
    start,
    list: () => order.map((id) => snapshot(entries.get(id)!)).reverse(),
    get: (id) => {
      const e = entries.get(id);
      return e ? snapshot(e) : undefined;
    },
    steer: (id, input) => {
      const e = entries.get(id);
      if (!e) return { ok: false, message: `Unknown task "${id}". Run tasks_list to see active tasks.` };
      if (e.rec.status !== 'running') {
        return { ok: false, message: `Task ${id} is not running (${e.rec.status}).` };
      }
      const sin = e.handle.child.stdin;
      if (sin && sin.writable) {
        sin.write(input.endsWith('\n') ? input : `${input}\n`);
        return { ok: true, message: `Sent input to task ${id}.` };
      }
      return {
        ok: false,
        message: `Task ${id} is not accepting input (one-shot delegate). Use tasks_interrupt to stop it.`,
      };
    },
    interrupt: (id) => {
      const e = entries.get(id);
      if (!e) return { ok: false, message: `Unknown task "${id}". Run tasks_list to see active tasks.` };
      if (e.rec.status !== 'running') {
        return { ok: false, message: `Task ${id} already ${e.rec.status}.` };
      }
      e.rec.status = 'interrupted';
      e.handle.child.kill('SIGTERM');
      return { ok: true, message: `Interrupted task ${id}.` };
    },
    whenSettled: (id) => {
      const e = entries.get(id);
      return e ? e.handle.done.then(() => undefined) : Promise.resolve();
    },
  };
}

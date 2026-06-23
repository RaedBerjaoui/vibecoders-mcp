import { describe, it, expect } from 'vitest';
import { createTaskRegistry, type TaskRecord } from '../src/tasks/registry';
import { formatTaskList, formatTaskDetail, registerTasks } from '../src/tasks/tools';
import type { Logger } from '../src/util/logger';

/** A Logger that records every warn() line, for asserting the catch/failure paths log. */
function capturingLogger(): { log: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const log: Logger = { debug() {}, info() {}, warn: (...a) => warnings.push(a.join(' ')), error() {} };
  return { log, warnings };
}

// Harmless node-backed delegate stand-ins (same approach as delegate.test.ts):
// no real codex/gemini is ever spawned.
const fast: any = {
  billing: 'test',
  id: 'fast',
  label: 'Fast',
  command: 'node',
  promptVia: 'stdin',
  args: () => ['-e', 'process.stdout.write("done-result")'],
};
const forever: any = {
  billing: 'test',
  id: 'loop',
  label: 'Loop',
  command: 'node',
  promptVia: 'stdin',
  args: () => ['-e', 'setInterval(()=>{},1000)'],
};

describe('TaskRegistry', () => {
  it('runs a delegate in the background and records its result', async () => {
    const reg = createTaskRegistry();
    const id = reg.start(fast, 'hi');
    expect(reg.get(id)!.status).toBe('running');
    await reg.whenSettled(id);
    const rec = reg.get(id)!;
    expect(rec.status).toBe('done');
    expect(rec.output).toContain('done-result');
    expect(rec.endedAt).toBeGreaterThanOrEqual(rec.startedAt);
  });

  it('interrupt() kills a running task and marks it interrupted', async () => {
    const reg = createTaskRegistry();
    const id = reg.start(forever, 'x');
    expect(reg.interrupt(id).ok).toBe(true);
    await reg.whenSettled(id);
    expect(reg.get(id)!.status).toBe('interrupted');
  });

  it('steer() reports when a one-shot task is not accepting input', async () => {
    const reg = createTaskRegistry();
    const id = reg.start(fast, 'x');
    await reg.whenSettled(id);
    const r = reg.steer(id, 'more');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not running|not accepting/i);
  });

  it('list() returns tasks newest-first and records a prompt preview', () => {
    const reg = createTaskRegistry();
    const a = reg.start(forever, 'alpha-prompt');
    const b = reg.start(forever, 'beta-prompt');
    const list = reg.list();
    expect(list[0]!.id).toBe(b);
    expect(list.map((t) => t.id)).toContain(a);
    expect(reg.get(a)!.promptPreview).toContain('alpha-prompt');
    reg.interrupt(a);
    reg.interrupt(b);
  });

  it('reports a clear message for unknown task ids', () => {
    const reg = createTaskRegistry();
    expect(reg.interrupt('nope').ok).toBe(false);
    expect(reg.steer('nope', 'x').ok).toBe(false);
    expect(reg.get('nope')).toBeUndefined();
  });
});

describe('task formatting', () => {
  const rec = (over: Partial<TaskRecord> = {}): TaskRecord => ({
    id: 't_1', provider: 'codex', mode: 'read', status: 'running',
    startedAt: 1000, output: '', promptPreview: 'do the thing', ...over,
  });

  it('formats an empty list with a start hint', () => {
    expect(formatTaskList([], 2000)).toMatch(/no background tasks/i);
  });

  it('formats a task line with id, status, provider and preview', () => {
    const out = formatTaskList([rec({})], 4000);
    expect(out).toContain('t_1');
    expect(out).toContain('running');
    expect(out).toContain('codex');
    expect(out).toContain('do the thing');
  });

  it('detail includes the full output', () => {
    const out = formatTaskDetail(rec({ status: 'done', endedAt: 1500, output: 'THE ANSWER' }));
    expect(out).toContain('THE ANSWER');
    expect(out).toContain('t_1');
  });
});

// T25 — registerTasks receives an injected Logger; its failure paths (unknown id
// / not-ok registry results) must warn so an operator tailing stderr isn't blind
// to them, matching memory/reference. We drive the registered tools over real
// MCP transport and assert log.warn fired.
describe('registerTasks — logs failure paths via the injected logger', () => {
  async function withTasks(
    run: (call: (name: string, args: Record<string, unknown>) => Promise<unknown>, warnings: string[]) => Promise<void>,
  ): Promise<void> {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

    const { log, warnings } = capturingLogger();
    const tasks = createTaskRegistry();
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerTasks(server, { tasks, log });

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0.0.0' });
    try {
      await Promise.all([server.connect(serverT), client.connect(clientT)]);
      await run((name, args) => client.callTool({ name, arguments: args }), warnings);
    } finally {
      await client.close();
    }
  }

  it('warns when tasks_list is given an unknown id', async () => {
    await withTasks(async (call, warnings) => {
      await call('tasks_list', { id: 'nope' });
      expect(warnings.some((w) => w.includes('[tasks_list]') && w.includes('nope'))).toBe(true);
    });
  });

  it('warns when tasks_steer targets an unknown id', async () => {
    await withTasks(async (call, warnings) => {
      await call('tasks_steer', { id: 'nope', input: 'x' });
      expect(warnings.some((w) => w.includes('[tasks_steer]') && w.includes('nope'))).toBe(true);
    });
  });

  it('warns when tasks_interrupt targets an unknown id', async () => {
    await withTasks(async (call, warnings) => {
      await call('tasks_interrupt', { id: 'nope' });
      expect(warnings.some((w) => w.includes('[tasks_interrupt]') && w.includes('nope'))).toBe(true);
    });
  });
});

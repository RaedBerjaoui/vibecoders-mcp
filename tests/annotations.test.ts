/**
 * MCP tool annotations — the safety/approval hints hosts key off. Codex's
 * approval system auto-proceeds on read-only-annotated tools and always prompts
 * on destructive ones; Claude Code displays them. These pins assert the hints
 * are attached and shaped correctly for a representative tool of each class:
 *   - read-only        (web_search / list_providers / search_tools / memory_recall)
 *   - write-not-destructive (generate_image / delegate)
 *   - destructive      (memory_forget)
 *   - open-world ONLY  (call_tool — downstream tool unknown, so NO read-only claim)
 *
 * Where a register* fn returns handles we read `.annotations` off them; where it
 * does not, we read the SDK's internal `_registeredTools` map (test-only).
 */
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCapabilities } from '../src/capabilities/tools';
import { registerProviders } from '../src/providers/tools';
import { registerGateway } from '../src/gateway/lazyTools';
import { registerMemory } from '../src/memory/tools';
import { ToolIndex } from '../src/gateway/registry';
import { Connector } from '../src/gateway/connector';
import type { Lane } from '../src/lanes/lane';
import type { Logger } from '../src/util/logger';

const silentLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const noSecret = (): undefined => undefined;

/** Read a tool's annotations straight off the SDK's internal registry (test-only). */
function ann(server: McpServer, name: string): Record<string, unknown> | undefined {
  const reg = (server as unknown as {
    _registeredTools: Record<string, { annotations?: Record<string, unknown> }>;
  })._registeredTools;
  return reg[name]?.annotations;
}

describe('tool annotations — capabilities (via returned handles)', () => {
  it('generate_image is write-but-not-destructive and open-world', () => {
    const server = new McpServer({ name: 't', version: '0' });
    const handles = registerCapabilities(server, noSecret, silentLog);
    expect(handles.generate_image!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  it('web_search is read-only AND open-world (hits the live web)', () => {
    const server = new McpServer({ name: 't', version: '0' });
    const handles = registerCapabilities(server, noSecret, silentLog);
    expect(handles.web_search!.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
  });
});

describe('tool annotations — providers (via returned handles)', () => {
  it('list_providers is read-only; delegate is write/scoped/open-world', () => {
    const server = new McpServer({ name: 't', version: '0' });
    const handles = registerProviders(server, { log: silentLog });
    expect(handles.list_providers!.annotations).toEqual({ readOnlyHint: true });
    expect(handles.delegate!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
  });
});

describe('tool annotations — gateway (via internal registry)', () => {
  it('search_tools/load_tool are read-only; call_tool is open-world ONLY', () => {
    const server = new McpServer({ name: 't', version: '0' });
    const connector = new Connector({}, noSecret, silentLog, 1000);
    registerGateway(server, {}, connector, new ToolIndex(), silentLog);
    expect(ann(server, 'search_tools')).toEqual({ readOnlyHint: true });
    expect(ann(server, 'load_tool')).toEqual({ readOnlyHint: true });
    // The downstream tool is unknown → the ONLY safe hint is openWorld; call_tool
    // must NOT claim read-only, or a mutating downstream call could auto-proceed.
    expect(ann(server, 'call_tool')).toEqual({ openWorldHint: true });
    expect(ann(server, 'call_tool')).not.toHaveProperty('readOnlyHint');
  });
});

describe('tool annotations — memory (via internal registry)', () => {
  it('memory_recall is read-only; memory_forget is destructive', () => {
    const server = new McpServer({ name: 't', version: '0' });
    const lane: Lane = { id: 'test-lane', label: 'test@main', cwd: '/tmp', branch: 'main' };
    registerMemory(server, { lane, getSecret: noSecret, memory: {}, log: silentLog });
    expect(ann(server, 'memory_recall')).toEqual({ readOnlyHint: true });
    expect(ann(server, 'memory_forget')).toEqual({ destructiveHint: true });
  });
});

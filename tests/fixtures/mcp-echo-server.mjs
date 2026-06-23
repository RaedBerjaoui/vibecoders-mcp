#!/usr/bin/env node
// Minimal downstream MCP server for gateway tests. Uses the low-level Server so tests can
// observe protocol traffic:
//   • appends its PID to $SPAWN_MARKER on startup     → prove the Connector spawns it once
//   • appends a line to $LIST_MARKER per tools/list   → prove listTools is cached, not re-RPC'd
// Exposes `echo` (round-trips) and `die` (self-exits, to exercise self-heal eviction).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { appendFileSync } from 'node:fs';

if (process.env.SPAWN_MARKER) appendFileSync(process.env.SPAWN_MARKER, `${process.pid}\n`);

const server = new Server({ name: 'echo-fixture', version: '0.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (process.env.LIST_MARKER) appendFileSync(process.env.LIST_MARKER, 'list\n');
  return {
    tools: [
      {
        name: 'echo',
        description: 'Echo the given text back',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
      { name: 'die', description: 'exit the process', inputSchema: { type: 'object', properties: {} } },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === 'die') {
    // Respond, then exit shortly after so the gateway sees the transport close (self-heal).
    setTimeout(() => process.exit(1), 50);
    return { content: [{ type: 'text', text: 'dying' }] };
  }
  return { content: [{ type: 'text', text: `echo: ${args?.text}` }] };
});

await server.connect(new StdioServerTransport());

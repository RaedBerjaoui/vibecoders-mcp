/**
 * T10 — the redactor must guard the DATA PLANE (tool responses), not just stderr.
 *
 * The control plane returns downstream output straight to the model: call_tool
 * JSON.stringifies a downstream result, delegate returns a child's raw stdout
 * (the child inherits full process.env), tasks/image/search embed raw child
 * output. A downstream error echoing an `Authorization` header — or a CLI that
 * prints `env` — would otherwise leak the secret verbatim into the transcript.
 *
 * The fix is a single chokepoint: util/mcp.ts `text()`/`errorText()` pass their
 * outgoing string through an installable redactor (default no-op, installed once
 * at boot from the same secret source the logger uses). These tests prove the
 * chokepoint scrubs, that the wiring is honest at a real tool boundary, and that
 * the happy path is untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { text, errorText, redactMcpResult, setResponseRedactor, resetResponseRedactor } from '../src/util/mcp';
import { makeRedactor } from '../src/util/redact';
import { ToolIndex } from '../src/gateway/registry';
import { registerGateway } from '../src/gateway/lazyTools';
import { Connector } from '../src/gateway/connector';
import type { Logger } from '../src/util/logger';

const silentLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const echoServer = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));

// A value-scrubbed secret (in the configured set) and a pattern-only token (NOT
// in the set, but key-shaped). Both fake, so secret scanners won't flag them.
const PLANTED_SECRET = 'super-secret-token-abcdef123456';
const PATTERN_TOKEN = 'sk-ant-' + 'FAKEKEYFORTESTSONLY';

const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.map((c) => c.text ?? '').join('');

describe('T10 response redactor — util chokepoint (text/errorText)', () => {
  // Always restore the no-op default so one test's install can't bleed into the
  // suite (these helpers are module-global, shared by every tool).
  afterEach(() => resetResponseRedactor());

  it('defaults to a no-op before install — non-secret text is byte-for-byte unchanged', () => {
    // CRITICAL for the 176 existing tests asserting exact tool output: with no
    // redactor installed, text()/errorText() must pass content through verbatim.
    resetResponseRedactor();
    const s = 'Saved generated image to /tmp/out.png (via OpenAI)';
    expect(textOf(text(s))).toBe(s);
    expect(textOf(errorText(s))).toBe(s);
    expect(errorText(s).isError).toBe(true);
  });

  it('scrubs a configured secret VALUE out of a response built via text()', () => {
    setResponseRedactor(makeRedactor([PLANTED_SECRET]));
    const out = textOf(text(`downstream error: Authorization: Bearer ${PLANTED_SECRET}`));
    expect(out).toContain('***');
    expect(out).not.toContain(PLANTED_SECRET);
  });

  it('scrubs a configured secret VALUE out of an errorText() response too', () => {
    setResponseRedactor(makeRedactor([PLANTED_SECRET]));
    const r = errorText(`Call failed: leaked ${PLANTED_SECRET} here`);
    expect(textOf(r)).toContain('***');
    expect(textOf(r)).not.toContain(PLANTED_SECRET);
    expect(r.isError).toBe(true);
  });

  it('still scrubs a bare key-shaped token by SECRET_PATTERNS (not in the value set)', () => {
    // The pattern layer is the fallback for tokens we never held as a value —
    // a downstream printing its OWN sk-ant key must not survive into the result.
    setResponseRedactor(makeRedactor([PLANTED_SECRET]));
    const out = textOf(text(`the agent printed ${PATTERN_TOKEN} to stdout`));
    expect(out).toContain('***');
    expect(out).not.toContain('sk-ant-FAKE');
  });

  it('does not over-redact: benign text is preserved after a redactor is installed', () => {
    setResponseRedactor(makeRedactor([PLANTED_SECRET]));
    const benign = 'Found 5 result(s) via Brave. see https://github.com/foo/bar v1.2.3';
    expect(textOf(text(benign))).toBe(benign);
  });

  it('recursively redacts native mixed MCP results without changing media blocks or result fields', () => {
    setResponseRedactor(makeRedactor([PLANTED_SECRET]));
    const result = redactMcpResult({
      content: [
        { type: 'text', text: `secret ${PLANTED_SECRET}` },
        { type: 'image', data: 'unchanged-image-data', mimeType: 'image/png' },
        { type: 'audio', data: 'unchanged-audio-data', mimeType: 'audio/wav' },
      ],
      structuredContent: { nested: { token: PLANTED_SECRET } },
      _meta: { diagnostic: PLANTED_SECRET }, isError: true,
    });
    expect(result.content[1]).toMatchObject({ type: 'image', data: 'unchanged-image-data' });
    expect(result.content[2]).toMatchObject({ type: 'audio', data: 'unchanged-audio-data' });
    expect(JSON.stringify(result)).not.toContain(PLANTED_SECRET);
    expect(result).toMatchObject({ isError: true, structuredContent: { nested: { token: '***' } } });
  });
});

describe('T10 response redactor — honest boundary (call_tool over real stdio)', () => {
  afterEach(() => resetResponseRedactor());

  it('redacts a secret a downstream echoes back through call_tool', async () => {
    // End-to-end proof the chokepoint actually guards the data plane: the echo
    // fixture round-trips whatever text it's given. We plant a configured secret
    // as the echo payload and assert call_tool's RETURNED text is scrubbed —
    // i.e. a downstream reflecting a token can't leak it into the transcript.
    setResponseRedactor(makeRedactor([PLANTED_SECRET]));

    // A minimal in-process MCP server we can drive call_tool against.
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

    const servers = { echo: { command: 'node', args: [echoServer], env: [], lazy: true } };
    const index = new ToolIndex();
    const connector = new Connector(servers, () => undefined, silentLog, 5000);
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerGateway(server, servers, connector, index, silentLog);

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0.0.0' });
    try {
      await Promise.all([server.connect(serverT), client.connect(clientT)]);
      const res = (await client.callTool({
        name: 'call_tool',
        arguments: { id: 'echo.echo', args: { text: `Bearer ${PLANTED_SECRET}` } },
      })) as { content: Array<{ type: string; text?: string }> };
      const out = textOf(res);
      // The downstream echoed the secret back; the chokepoint must have scrubbed it.
      expect(out).toContain('***');
      expect(out).not.toContain(PLANTED_SECRET);
    } finally {
      await connector.closeAll();
      await client.close();
    }
  }, 15000);
});

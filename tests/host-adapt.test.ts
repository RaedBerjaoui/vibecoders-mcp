/**
 * Host adaptation — the synchronous, in-handshake tailoring of tool visibility
 * and descriptions to the driving client. Pins the full rule table, idempotency
 * (initialize can fire twice on reconnect), and a guard that the MCP SDK still
 * exposes the private internals the index.ts initialize override hangs off.
 */
import { describe, it, expect } from 'vitest';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { applyHostAdaptations } from '../src/host/adapt';
import { PROFILES } from '../src/host/profile';

// Distinctive originals so exact before/after equality is meaningful.
const GEN_ORIG = 'GEN original description';
const WS_ORIG = 'WS original description';
const DL_ORIG = 'DL original description';

// The exact contract strings (with their intentional leading/trailing spaces).
const IMAGE_ALT_PREFIX = 'Alternate engine to your native image generation. ';
const SEARCH_LIVE_PREFIX =
  'Live grounded web search (your native web.run defaults to a cached index). ';
const CODEX_NOTE =
  ' You are running in Codex: delegate to claude or gemini for a second engine; prefer background:true for long tasks (Codex kills foreground MCP calls at ~60s by default).';
const CLAUDE_NOTE = ' You are running in Claude Code: codex or gemini give you a second engine.';
const GEMINI_NOTE = ' You are running in Gemini CLI: claude or codex give you a second engine.';

/** Build a fresh server with three stub tools and capture their handles. */
function build() {
  const server = new McpServer({ name: 't', version: '0' });
  const stub = () => ({ content: [{ type: 'text' as const, text: '' }] });
  const generate_image = server.registerTool('generate_image', { description: GEN_ORIG }, stub);
  const web_search = server.registerTool('web_search', { description: WS_ORIG }, stub);
  const delegate = server.registerTool('delegate', { description: DL_ORIG }, stub);
  const handles: Record<string, RegisteredTool | undefined> = {
    generate_image,
    web_search,
    delegate,
  };
  return { handles, generate_image, web_search, delegate };
}

describe('applyHostAdaptations — Codex image rules', () => {
  it('HIDES generate_image when Codex already covers the engine natively', () => {
    for (const imageProviderId of ['codex-cli', 'openai-api']) {
      const { handles, generate_image } = build();
      const log = applyHostAdaptations(PROFILES.codex, handles, { imageProviderId });
      expect(generate_image.enabled).toBe(false);
      expect(log).toContain(
        'hid generate_image (Codex has native image generation on the same engine)',
      );
    }
  });

  it('REFRAMES generate_image as an alternate engine when a different provider is configured', () => {
    const { handles, generate_image } = build();
    applyHostAdaptations(PROFILES.codex, handles, { imageProviderId: 'gemini-api' });
    expect(generate_image.enabled).toBe(true);
    expect(generate_image.description).toBe(IMAGE_ALT_PREFIX + GEN_ORIG);
  });

  it('leaves generate_image untouched when no image provider is resolved', () => {
    const { handles, generate_image } = build();
    const log = applyHostAdaptations(PROFILES.codex, handles, {});
    expect(generate_image.enabled).toBe(true);
    expect(generate_image.description).toBe(GEN_ORIG);
    expect(log).not.toContain(
      'hid generate_image (Codex has native image generation on the same engine)',
    );
  });
});

describe('applyHostAdaptations — web_search rules', () => {
  it('reframes web_search on Codex as the LIVE path vs its cached web.run', () => {
    const { handles, web_search } = build();
    applyHostAdaptations(PROFILES.codex, handles, {});
    expect(web_search.enabled).toBe(true);
    expect(web_search.description).toBe(SEARCH_LIVE_PREFIX + WS_ORIG);
  });

  it('HIDES web_search on Gemini CLI when the search engine is Gemini', () => {
    for (const searchProviderId of ['gemini-cli', 'gemini-api']) {
      const { handles, web_search } = build();
      const log = applyHostAdaptations(PROFILES['gemini-cli'], handles, { searchProviderId });
      expect(web_search.enabled).toBe(false);
      expect(log).toContain(
        'hid web_search (Gemini CLI has native live web search on the same engine)',
      );
    }
  });

  it('keeps web_search on Gemini CLI when a NON-Gemini engine is configured', () => {
    const { handles, web_search } = build();
    applyHostAdaptations(PROFILES['gemini-cli'], handles, { searchProviderId: 'brave-api' });
    expect(web_search.enabled).toBe(true);
    expect(web_search.description).toBe(WS_ORIG); // gemini-cli never reframes search text
  });
});

describe('applyHostAdaptations — delegate note (per host)', () => {
  it('appends the Codex note', () => {
    const { handles, delegate } = build();
    applyHostAdaptations(PROFILES.codex, handles, {});
    expect(delegate.description).toBe(DL_ORIG + CODEX_NOTE);
  });

  it('appends the Claude Code note', () => {
    const { handles, delegate } = build();
    applyHostAdaptations(PROFILES['claude-code'], handles, {});
    expect(delegate.description).toBe(DL_ORIG + CLAUDE_NOTE);
  });

  it('appends the Gemini CLI note', () => {
    const { handles, delegate } = build();
    applyHostAdaptations(PROFILES['gemini-cli'], handles, {});
    expect(delegate.description).toBe(DL_ORIG + GEMINI_NOTE);
  });
});

describe('applyHostAdaptations — host gating (untouched surfaces)', () => {
  it('Claude Code leaves image + search EXACTLY untouched, only annotating delegate', () => {
    const { handles, generate_image, web_search, delegate } = build();
    const log = applyHostAdaptations(PROFILES['claude-code'], handles, {
      imageProviderId: 'openai-api', // would hide on Codex, but must NOT here
      searchProviderId: 'gemini-api',
    });
    expect(generate_image.enabled).toBe(true);
    expect(generate_image.description).toBe(GEN_ORIG);
    expect(web_search.enabled).toBe(true);
    expect(web_search.description).toBe(WS_ORIG);
    expect(delegate.description).toBe(DL_ORIG + CLAUDE_NOTE);
    expect(log).toEqual(['annotated delegate for Claude Code']);
  });

  it('an unrecognized host makes ZERO changes and returns []', () => {
    const { handles, generate_image, web_search, delegate } = build();
    const log = applyHostAdaptations(PROFILES.unknown, handles, {
      imageProviderId: 'codex-cli',
      searchProviderId: 'gemini-cli',
    });
    expect(log).toEqual([]);
    expect(generate_image.enabled).toBe(true);
    expect(generate_image.description).toBe(GEN_ORIG);
    expect(web_search.enabled).toBe(true);
    expect(web_search.description).toBe(WS_ORIG);
    expect(delegate.description).toBe(DL_ORIG);
  });

  it('skips undefined handles silently (feature group off)', () => {
    const { handles } = build();
    handles.generate_image = undefined;
    handles.web_search = undefined;
    const log = applyHostAdaptations(PROFILES.codex, handles, { imageProviderId: 'codex-cli' });
    // No throw on the missing tools; the present delegate still gets its note.
    expect(log).toEqual(['annotated delegate for OpenAI Codex']);
  });
});

describe('applyHostAdaptations — idempotency (initialize can fire twice)', () => {
  it('does not double-apply description prefixes/suffixes and returns a stable log', () => {
    const { handles, generate_image, web_search, delegate } = build();
    const first = applyHostAdaptations(PROFILES.codex, handles, { imageProviderId: 'gemini-api' });
    const second = applyHostAdaptations(PROFILES.codex, handles, { imageProviderId: 'gemini-api' });
    expect(second).toEqual(first);
    expect(generate_image.description).toBe(IMAGE_ALT_PREFIX + GEN_ORIG); // NOT doubled
    expect(web_search.description).toBe(SEARCH_LIVE_PREFIX + WS_ORIG);
    expect(delegate.description).toBe(DL_ORIG + CODEX_NOTE);
    expect(generate_image.enabled).toBe(true);
  });

  it('is stable across repeated calls on the HIDE path too', () => {
    const { handles, generate_image } = build();
    const first = applyHostAdaptations(PROFILES.codex, handles, { imageProviderId: 'codex-cli' });
    const second = applyHostAdaptations(PROFILES.codex, handles, { imageProviderId: 'codex-cli' });
    expect(second).toEqual(first);
    expect(generate_image.enabled).toBe(false);
  });
});

describe('MCP SDK shape guard (initialize override depends on these internals)', () => {
  it('still exposes the private _oninitialize hook and getClientVersion store', () => {
    // If EITHER assertion fails, the SDK internals changed: the initialize override
    // in src/index.ts (which binds & delegates to _oninitialize so clientInfo is
    // still stored, then reads it back) must be re-reviewed — all per-client
    // adaptation hangs off this hook.
    const server = new McpServer({ name: 't', version: '0' });
    expect(typeof (server.server as unknown as { _oninitialize?: unknown })._oninitialize).toBe(
      'function',
    );
    expect(typeof server.server.getClientVersion).toBe('function');
  });
});

/**
 * Host adaptation — the SYNCHRONOUS half of per-client tailoring. Where
 * `instructionsFor` rewrites the server's instruction string, this mutates the
 * already-registered tool objects in place: hiding a tool the host already
 * covers natively, or reframing a surviving one so the model reads it correctly.
 *
 * It runs INSIDE the initialize handler, before the first tools/list — Codex
 * caches that list per session and ignores tools/list_changed, so any visibility
 * change has to be applied before the handshake returns. We therefore mutate the
 * plain `.enabled` / `.description` fields the SDK's list handler reads live, and
 * never call `.disable()` / `.update()` (which would fire a notification
 * mid-handshake).
 *
 * IDEMPOTENT: initialize can fire again on reconnect, so every description edit
 * recomputes from a snapshot of the tool's PRISTINE text instead of stacking a
 * prefix/suffix, and the returned change-log is stable across identical calls.
 */
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HostId, HostProfile } from './profile';

export interface AdaptCtx {
  /** Resolved image_gen provider id this session (see resolveCapability), if any. */
  imageProviderId?: string;
  /** Resolved web_search provider id this session, if any. */
  searchProviderId?: string;
}

/** Image providers whose engine Codex already ships natively → generate_image is a duplicate. */
const CODEX_NATIVE_IMAGE = new Set(['codex-cli', 'openai-api']);
/** Search providers that ARE Gemini → web_search duplicates Gemini CLI's own google_web_search. */
const GEMINI_NATIVE_SEARCH = new Set(['gemini-cli', 'gemini-api']);

/** Exact prefixes/suffixes (with their intentional trailing/leading spaces). */
const IMAGE_ALT_PREFIX = 'Alternate engine to your native image generation. ';
const SEARCH_LIVE_PREFIX =
  'Live grounded web search (your native web.run defaults to a cached index). ';
const DELEGATE_NOTE: Partial<Record<HostId, string>> = {
  codex:
    ' You are running in Codex: delegate to claude or gemini for a second engine; prefer background:true for long tasks (Codex kills foreground MCP calls at ~60s by default).',
  'claude-code': ' You are running in Claude Code: codex or gemini give you a second engine.',
  'gemini-cli': ' You are running in Gemini CLI: claude or codex give you a second engine.',
};

/**
 * Snapshot each tool's ORIGINAL description the first time we touch it. Keyed by
 * the RegisteredTool identity (WeakMap → no leak, no cross-test contamination:
 * every server builds fresh tool objects). A second initialize recomputes from
 * this pristine text, so prefixes/suffixes never double-apply.
 */
const pristineDescriptions = new WeakMap<RegisteredTool, string>();

function pristine(handle: RegisteredTool): string {
  if (!pristineDescriptions.has(handle)) {
    pristineDescriptions.set(handle, handle.description ?? '');
  }
  return pristineDescriptions.get(handle)!;
}

/**
 * Adapt the given tool handles to the driving host, returning a human-readable
 * change log ([] when nothing changed, e.g. an unrecognized host). Handles may
 * be undefined when a feature group is off — those are skipped silently.
 */
export function applyHostAdaptations(
  p: HostProfile,
  handles: Record<string, RegisteredTool | undefined>,
  ctx: AdaptCtx,
): string[] {
  const changes: string[] = [];
  const image = handles.generate_image;
  const search = handles.web_search;
  const delegate = handles.delegate;

  if (p.id === 'codex' && image) {
    if (ctx.imageProviderId && CODEX_NATIVE_IMAGE.has(ctx.imageProviderId)) {
      // Same engine, twice over — hide our tool and let Codex use its own.
      image.enabled = false;
      changes.push('hid generate_image (Codex has native image generation on the same engine)');
    } else if (ctx.imageProviderId) {
      // A different engine (e.g. Gemini) — keep it, but frame it as the alternate.
      image.enabled = true;
      image.description = IMAGE_ALT_PREFIX + pristine(image);
      changes.push('reframed generate_image as an alternate engine to Codex native image generation');
    }
  }

  if (p.id === 'codex' && search) {
    // Codex's web.run is a cached index by default; flag web_search as the LIVE path.
    search.description = SEARCH_LIVE_PREFIX + pristine(search);
    changes.push('reframed web_search as live grounded search vs Codex cached web.run');
  }

  if (
    p.id === 'gemini-cli' &&
    search &&
    ctx.searchProviderId &&
    GEMINI_NATIVE_SEARCH.has(ctx.searchProviderId)
  ) {
    // Gemini CLI already ships live google_web_search on the same engine — hide ours.
    search.enabled = false;
    changes.push('hid web_search (Gemini CLI has native live web search on the same engine)');
  }

  if (delegate) {
    const note = DELEGATE_NOTE[p.id];
    if (note) {
      delegate.description = pristine(delegate) + note;
      changes.push(`annotated delegate for ${p.label}`);
    }
  }

  return changes;
}

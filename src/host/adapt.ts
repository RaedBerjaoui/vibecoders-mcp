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
 * CONVERGENT: initialize can fire again on reconnect — and the reconnecting
 * client may DIFFER from the first (e.g. a Codex session that hid generate_image
 * and reworded web_search, then a Claude Code reconnect on the same tool objects).
 * So we open with a RESET pass: snapshot each handle's pristine {description,
 * enabled} on first sight, then restore every handle to that snapshot BEFORE
 * applying the current profile's rules. The outcome depends only on the current
 * profile + ctx, never on prior calls — idempotent per host AND correct across a
 * host switch. The returned change-log is stable across identical calls.
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
    ' You are running in Codex: call list_providers and delegate only to an installed non-self engine; prefer background:true for long tasks (Codex kills foreground MCP calls at ~60s by default).',
  'claude-code':
    ' You are running in Claude Code: call list_providers and delegate only to an installed non-self engine.',
  'gemini-cli':
    ' You are running in Gemini CLI: call list_providers and delegate only to an installed non-self engine.',
};

/** A tool's pristine, pre-adaptation state — what every call restores to first. */
interface PristineState {
  description: string;
  enabled: boolean;
}

/**
 * Snapshot each tool's ORIGINAL {description, enabled} the first time we touch
 * it. Keyed by the RegisteredTool identity (WeakMap → no leak, no cross-test
 * contamination: every server builds fresh tool objects). Every call restores
 * from this snapshot before applying rules, so neither a prefix/suffix nor a
 * hidden `enabled` ever carries over from a previous (possibly different) host.
 */
const pristineState = new WeakMap<RegisteredTool, PristineState>();

function pristine(handle: RegisteredTool): PristineState {
  let snap = pristineState.get(handle);
  if (!snap) {
    snap = { description: handle.description ?? '', enabled: handle.enabled };
    pristineState.set(handle, snap);
  }
  return snap;
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

  // RESET pass — snapshot each handle's pristine state on first sight, then
  // restore every handle to it before applying this profile's rules. This is
  // what makes the function CONVERGENT from any prior state (e.g. a previous
  // Codex init that hid generate_image and reworded web_search), not merely
  // idempotent when the SAME host reconnects. Restores in place — same reason as
  // the rules: never call .disable()/.update() (they fire notifications).
  for (const handle of Object.values(handles)) {
    if (!handle) continue;
    const snap = pristine(handle);
    handle.description = snap.description;
    handle.enabled = snap.enabled;
  }

  const image = handles.generate_image;
  const search = handles.web_search;
  const delegate = handles.delegate;

  if (p.id === 'codex' && image) {
    if (!ctx.imageProviderId || CODEX_NATIVE_IMAGE.has(ctx.imageProviderId)) {
      // Same engine, twice over — hide our tool and let Codex use its own.
      image.enabled = false;
      changes.push('hid generate_image (Codex has native image generation on the same engine)');
    } else if (ctx.imageProviderId) {
      // A different engine (e.g. Gemini) — keep it, but frame it as the alternate.
      image.enabled = true;
      image.description = IMAGE_ALT_PREFIX + pristine(image).description;
      changes.push('reframed generate_image as an alternate engine to Codex native image generation');
    }
  }

  if (p.id === 'codex' && search) {
    if (!ctx.searchProviderId) {
      search.enabled = false;
      changes.push('hid web_search (no Vibecoders search provider is ready)');
    } else {
      // Codex's web.run is a cached index by default; flag web_search as the LIVE path.
      search.description = SEARCH_LIVE_PREFIX + pristine(search).description;
      changes.push('reframed web_search as live grounded search vs Codex cached web.run');
    }
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
      delegate.description = pristine(delegate).description + note;
      changes.push(`annotated delegate for ${p.label}`);
    }
  }

  return changes;
}

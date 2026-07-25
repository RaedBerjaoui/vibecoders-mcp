/**
 * Design RAG — opt-in (features.rag). A design-intelligence layer that lifts
 * Claude's UI/website/component output above its generic defaults, delivered
 * ON DEMAND so it costs ~nothing until a design task needs it:
 *   • design_core  — the lean always-relevant core: the anti-AI-design standard
 *                    (make the output not read as AI-made and hold its formatting),
 *                    the tells principle, and the build non-negotiables.
 *                    Called once at the start of a build.
 *   • design_layer — pull ONE deeper layer by name (donts, formatting,
 *                    directives, scaffolds, type_pointers, image_gen) only when
 *                    the build actually needs it.
 *
 * The CONTENT is not bundled with this package. It loads at startup from a local
 * directory — ~/.vibecoders/design-rag/{core.json,layers.json} by default,
 * overridable via VIBECODERS_DESIGN_RAG_DIR (VIBECODERS_HOME moves the parent) —
 * so the public package ships the capability while the design knowledge itself
 * stays private, bring-your-own. scripts/build-rag-data.mjs generates the two
 * files from a design-knowledge source tree. When the content is absent the
 * tools stay registered and answer with a short not-installed note. Cores are
 * PURE (take the data explicitly) so tests pass fixtures instead of a payload.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { text, errorText } from '../util/mcp';
import type { Logger } from '../util/logger';
import type { HostProfile } from '../host/profile';

/** The ordered set of deeper layers. Source of truth for the design_layer enum;
 *  parity with the loaded data is asserted in tests via fixtures so the enum and
 *  the generator can't drift. */
export const LAYER_NAMES = [
  'donts',
  'formatting',
  'directives',
  'scaffolds',
  'type_pointers',
  'image_gen',
] as const;
export type LayerName = (typeof LAYER_NAMES)[number];

export interface RagCore {
  content: string;
}
export type RagLayers = Record<string, string>;
export interface RagData {
  core: RagCore;
  layers: RagLayers;
}

/** Optional runtime facts. Omitted context preserves the original verbatim render API. */
export interface RagRenderContext {
  host?: HostProfile;
  imageProviderId?: string;
}

/** Generous byte bound — no current layer approaches it, so nothing truncates;
 *  it only exists so a future oversized layer degrades gracefully, like vault. */
const MAX_LAYER_BYTES = 200_000;

/** Where the local design-RAG content lives. Mirrors configPath()'s home logic. */
export function designRagDir(): string {
  const explicit = process.env.VIBECODERS_DESIGN_RAG_DIR;
  if (explicit) return explicit;
  const home = process.env.VIBECODERS_HOME ?? join(homedir(), '.vibecoders');
  return join(home, 'design-rag');
}

/** Load {core,layers} from the local dir. Absent or malformed content resolves
 *  to null (the not-installed state) — never a throw at startup. */
export function loadRagData(dir = designRagDir()): RagData | null {
  try {
    const core = JSON.parse(readFileSync(join(dir, 'core.json'), 'utf8')) as RagCore;
    const layers = JSON.parse(readFileSync(join(dir, 'layers.json'), 'utf8')) as RagLayers;
    if (typeof core?.content !== 'string' || core.content.length === 0) return null;
    if (layers === null || typeof layers !== 'object' || Array.isArray(layers)) return null;
    return { core, layers };
  } catch {
    return null;
  }
}

const NOT_INSTALLED =
  'The design RAG is not installed locally. Put core.json and layers.json in ' +
  '~/.vibecoders/design-rag/ (or point VIBECODERS_DESIGN_RAG_DIR at them); ' +
  'scripts/build-rag-data.mjs generates both from your own design-knowledge tree.';

/** The always-loaded core text. Pure: caller supplies the data. */
function executionPolicy(ctx?: RagRenderContext): string {
  if (!ctx?.host) return '';
  switch (ctx.host.id) {
    case 'codex':
      return ctx.imageProviderId === 'gemini-api'
        ? 'HOST EXECUTION POLICY (binding; overrides conflicting corpus text): Use Codex native image generation by default. generate_image is intentionally available as an alternate engine. Never invoke or delegate to codex-cli merely to generate an image.'
        : 'HOST EXECUTION POLICY (binding; overrides conflicting corpus text): Use Codex native image generation directly. generate_image is hidden. Never invoke or delegate to codex-cli merely to generate an image.';
    case 'claude-code':
      return 'HOST EXECUTION POLICY (binding; overrides conflicting corpus text): When configured, use the external generate_image path. A background subagent may be used when useful, but is never required.';
    case 'gemini-cli':
      return 'HOST EXECUTION POLICY (binding; overrides conflicting corpus text): Use capabilities actually surfaced by this client; do not assume a subagent suite exists.';
    default:
      return 'HOST EXECUTION POLICY (binding; overrides conflicting corpus text): Choose only capabilities actually available in this host.';
  }
}

function policyApplies(name: string): boolean {
  return name === 'design_core' || ['directives', 'scaffolds', 'image_gen'].includes(name);
}

export function renderCore(core: RagCore, ctx?: RagRenderContext): string {
  const policy = executionPolicy(ctx);
  return policy ? `${policy}\n\n${core.content}` : core.content;
}

/** Layer names that actually carry content (for the fail-closed hint + parity). */
export function availableLayers(layers: RagLayers): string[] {
  return Object.keys(layers);
}

/** One deeper layer by name, byte-capped. Throws (with the valid list) on an unknown name. */
function filteredDonts(body: string, host?: HostProfile): string {
  if (!host) return body;
  try {
    const parsed = JSON.parse(body) as { tells?: unknown; counts?: unknown };
    if (!Array.isArray(parsed.tells)) return body;
    const allowed = host.id === 'codex' ? new Set(['shared', 'codex']) : host.id === 'claude-code' ? new Set(['shared', 'claude']) : host.id === 'gemini-cli' ? new Set(['shared']) : undefined;
    if (!allowed) return body;
    const tells = parsed.tells.filter((tell) => {
      if (!tell || typeof tell !== 'object') return false;
      const audience = (tell as Record<string, unknown>).models;
      const values = Array.isArray(audience) ? audience : [audience ?? 'shared'];
      return values.some((value) => typeof value === 'string' && allowed.has(value));
    });
    const count = (model: string) =>
      tells.filter((tell) => {
        const value = (tell as Record<string, unknown>).models;
        return (Array.isArray(value) ? value : [value ?? 'shared']).includes(model);
      }).length;
    return JSON.stringify(
      { ...parsed, tells, counts: { total: tells.length, claude: count('claude'), codex: count('codex'), shared: count('shared') } },
      null,
      2,
    );
  } catch {
    return body;
  }
}

export function renderLayer(
  layers: RagLayers,
  name: string,
  maxBytes = MAX_LAYER_BYTES,
  ctx?: RagRenderContext,
): string {
  const body = layers[name];
  if (body === undefined) {
    throw new Error(`unknown layer "${name}". Available: ${availableLayers(layers).join(', ')}`);
  }
  const rendered = name === 'donts' ? filteredDonts(body, ctx?.host) : body;
  const policy = policyApplies(name) ? executionPolicy(ctx) : '';
  return `${policy ? `${policy}\n\n` : ''}${rendered}`.slice(0, maxBytes);
}

// ---- registration -----------------------------------------------------------

export function registerRag(
  server: McpServer,
  deps: { log: Logger; getHost?: () => HostProfile; getImageProviderId?: () => string | undefined },
): void {
  const { log, getHost, getImageProviderId } = deps;
  const data = loadRagData();
  if (data === null) {
    log.info(`[rag] no local design-RAG content at ${designRagDir()}; tools answer not-installed`);
  }

  server.registerTool(
    'design_core',
    {
      description:
        'Load the design-intelligence core of the anti-AI-design RAG: the standard that makes the output NOT read as AI-made and hold its formatting across every screen, the tells principle (displace the bias, never the surface instance), the build non-negotiables, and the menu of deeper layers. Call this FIRST when building ANY UI, website, page, component, or visual, then pull a layer with design_layer. Opt-in (features.rag).',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      data
        ? text(renderCore(data.core, { host: getHost?.(), imageProviderId: getImageProviderId?.() }))
        : text(NOT_INSTALLED),
  );

  server.registerTool(
    'design_layer',
    {
      description:
        'Pull ONE deeper design layer on demand, by name: donts (the vibecoded-tells catalogue — self-check the plan against it before shipping), formatting (the laws that make a page fill any screen with no dead margin and nothing clipped), directives (hard build directives: how to source visuals and structure a one-page site), scaffolds (occupancy-correct section scaffolds and their CSS — one dominant each), type_pointers (formatting-safe typographic elevation), image_gen (how to source imagery: your client\'s native image generation or the generate_image tool). Call design_core first; pull a layer only when the build needs it. Opt-in (features.rag).',
      inputSchema: {
        layer: z.enum(LAYER_NAMES).describe('which layer to load'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ layer }) => {
      if (!data) return text(NOT_INSTALLED);
      try {
        const host = getHost?.();
        let out = renderLayer(data.layers, layer, MAX_LAYER_BYTES, {
          host,
          imageProviderId: getImageProviderId?.(),
        });
        return text(out);
      } catch (e) {
        log.warn(`[design_layer] ${(e as Error).message}`);
        return errorText(`design_layer failed: ${(e as Error).message}`);
      }
    },
  );
}

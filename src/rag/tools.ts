/**
 * Design RAG — opt-in (features.rag). A brand-agnostic design-intelligence layer
 * that lifts Claude's UI/website/component output above its generic defaults.
 * Delivered ON DEMAND so it costs ~nothing until a design task needs it:
 *   • design_core  — the lean always-relevant core: the affirmative standard plus
 *                    the two pre-build gates (derive-from-the-brand, aliveness).
 *                    Called once at the start of a build.
 *   • design_layer — pull ONE deeper layer by name (donts, craft, cards,
 *                    capabilities, typography, image_gen, standard) only when the
 *                    build actually needs it.
 *
 * The content rides INSIDE dist/index.js as inlined JSON (src/rag/data/*.json,
 * esbuild Route A), so the capability is fully self-contained — no runtime file
 * resolution, works identically in dev, npx, and the plugin clone. Imagery is not
 * coupled here: the image_gen layer simply points the model at the existing
 * generate_image tool. Cores are PURE (take the data explicitly) so tests pass
 * fixtures instead of the bundled payload.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { text, errorText } from '../util/mcp';
import type { Logger } from '../util/logger';
import coreData from './data/core.json';
import layersData from './data/layers.json';

/** The ordered set of deeper layers. Source of truth for the design_layer enum;
 *  parity with the generated data keys is asserted in tests so they can't drift. */
export const LAYER_NAMES = [
  'donts',
  'craft',
  'cards',
  'capabilities',
  'typography',
  'image_gen',
  'standard',
] as const;
export type LayerName = (typeof LAYER_NAMES)[number];

export interface RagCore {
  content: string;
}
export type RagLayers = Record<string, string>;

/** Generous byte bound — no current layer approaches it, so nothing truncates;
 *  it only exists so a future oversized layer degrades gracefully, like vault. */
const MAX_LAYER_BYTES = 200_000;

/** The always-loaded core text. Pure: caller supplies the data. */
export function renderCore(core: RagCore): string {
  return core.content;
}

/** Layer names that actually carry content (for the fail-closed hint + parity). */
export function availableLayers(layers: RagLayers): string[] {
  return Object.keys(layers);
}

/** One deeper layer by name, byte-capped. Throws (with the valid list) on an unknown name. */
export function renderLayer(layers: RagLayers, name: string, maxBytes = MAX_LAYER_BYTES): string {
  const body = layers[name];
  if (body === undefined) {
    throw new Error(`unknown layer "${name}". Available: ${availableLayers(layers).join(', ')}`);
  }
  return body.slice(0, maxBytes);
}

// ---- registration -----------------------------------------------------------

export function registerRag(server: McpServer, deps: { log: Logger }): void {
  const { log } = deps;
  const core = coreData as RagCore;
  const layers = layersData as RagLayers;

  server.registerTool(
    'design_core',
    {
      description:
        'Load the design-intelligence core: an elite, anti-generic design standard plus the two pre-build gates (derive-everything-from-the-brand, and aliveness). Call this FIRST when building ANY UI, website, page, component, or visual, then pull deeper craft with design_layer. Opt-in (features.rag).',
      inputSchema: {},
    },
    async () => text(renderCore(core)),
  );

  server.registerTool(
    'design_layer',
    {
      description:
        'Pull ONE deeper design layer on demand, by name: donts (vibecoded tells to avoid — self-check the plan before shipping), craft (seamless motion + pro-look visual craft), cards (worked technique exemplars), capabilities (the situational palette: 2.5D photo, shaders, particles, video, 3D), typography, image_gen (how to generate imagery — render it with the generate_image tool), standard (the corpus bar). Call design_core first; pull a layer only when the build needs it. Opt-in (features.rag).',
      inputSchema: {
        layer: z.enum(LAYER_NAMES).describe('which layer to load'),
      },
    },
    async ({ layer }) => {
      try {
        return text(renderLayer(layers, layer));
      } catch (e) {
        log.warn(`[design_layer] ${(e as Error).message}`);
        return errorText(`design_layer failed: ${(e as Error).message}`);
      }
    },
  );
}

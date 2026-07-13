/**
 * Generate the LOCAL design-RAG content, {core,layers}.json, from a
 * design-knowledge source tree.
 *
 * The content is NOT committed to this repo and NOT bundled into dist. The
 * design_core / design_layer tools load it at startup from the local content
 * dir — ~/.vibecoders/design-rag by default, VIBECODERS_DESIGN_RAG_DIR to
 * override (VIBECODERS_HOME moves the parent) — so the public package ships
 * the capability while the knowledge itself stays private, bring-your-own.
 *
 *   node scripts/build-rag-data.mjs <design-rag rag/ dir>
 *   DESIGN_RAG_SRC=/path/to/rag node scripts/build-rag-data.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SRC = process.argv[2] || process.env.DESIGN_RAG_SRC;
if (!SRC) {
  console.error('usage: node scripts/build-rag-data.mjs <design-rag rag/ dir>');
  process.exit(1);
}
const OUT =
  process.env.VIBECODERS_DESIGN_RAG_DIR ??
  join(process.env.VIBECODERS_HOME ?? join(homedir(), '.vibecoders'), 'design-rag');
mkdirSync(OUT, { recursive: true });
const read = (p) => readFileSync(join(SRC, p), 'utf8');

// The always-loaded core is the affirmative standard (dos.md, which carries the
// anti-AI-design method + the build non-negotiables), plus an index telling the
// model which deeper layer to pull on demand and how imagery composes with the
// existing generate_image tool. Deeper layers stay out of context until pulled.
const LAYER_INDEX = `

## Design layers — pull on demand

The text above is the always-loaded core: the anti-AI-design standard, the tells principle, and the build non-negotiables. For depth, call \`design_layer\` with one of these names. Pull a layer only when the build needs it; do not pull them all.

- \`donts\` — the catalogue of vibecoded tells to avoid, machine-readable. Each tell names a generative BIAS and its counter-move; displace the bias, never the surface instance. PULL THIS and self-check the plan against it BEFORE you ship.
- \`formatting\` — the laws that make a page FILL any screen through fluid methodology (cap the reading measure, never the canvas; no dead margin, nothing clipped). Pull when laying out or sizing anything.
- \`directives\` — hard build directives: how to SOURCE visuals and STRUCTURE a one-page site, each a floor with a fixed replacement.
- \`scaffolds\` — the occupancy-correct section scaffolds and their CSS: every section starts from one, one dominant each, no dead empty half. Pull when composing sections.
- \`type_pointers\` — formatting-safe typographic elevation; changes how type READS, never how the box lays out.
- \`image_gen\` — how to generate and place imagery that belongs. Generate every visual with the \`generate_image\` tool (give it an absolute out_path inside your build dir); never hand-draw an SVG stand-in.
`;

const core = { content: read('dos.md') + LAYER_INDEX };
const layers = {
  donts: read('tells.json'),
  formatting: `${read('formatting-index.md')}\n\n${read('formatting.json')}`,
  directives: `${read('directives-index.md')}\n\n${read('directives.json')}`,
  scaffolds: `${read('scaffolds-index.md')}\n\n${read('scaffolds.json')}\n\n\`\`\`css\n${read('scaffolds.css')}\n\`\`\`\n`,
  type_pointers: `${read('type-pointers-index.md')}\n\n${read('type-pointers.json')}`,
  image_gen: read('image-gen.md'),
};

writeFileSync(join(OUT, 'core.json'), `${JSON.stringify(core, null, 2)}\n`);
writeFileSync(join(OUT, 'layers.json'), `${JSON.stringify(layers, null, 2)}\n`);

const kb = (s) => `${Math.round(s.length / 1024)}KB`;
console.log(`wrote ${join(OUT, 'core.json')}`, kb(core.content));
for (const [k, v] of Object.entries(layers)) console.log(`  layer ${k}: ${kb(v)}`);

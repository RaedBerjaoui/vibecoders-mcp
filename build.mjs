import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Single source of truth for the version: bake package.json's into the handshake.
  define: { __VIBE_VERSION__: JSON.stringify(pkg.version) },
  // Bundle deps INTO the artifact. The Claude Code plugin / marketplace path clones
  // dist/index.js with no `npm install`, so runtime `import` of externals would fail
  // (ERR_MODULE_NOT_FOUND). A single self-contained file boots from anywhere — the
  // same artifact backs both `npx vibecoders-mcp` and the plugin's .mcp.json.
  sourcemap: false,
  // Restore a working CommonJS `require` for the ESM output. Bundled CJS deps
  // (e.g. cross-spawn, used by the SDK's stdio transport) call require('child_process')
  // for Node built-ins; esbuild's __require shim delegates to this when present,
  // instead of throwing "Dynamic require of X is not supported".
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __vibeCreateRequire } from 'node:module';",
      'const require = __vibeCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});

console.log('built dist/index.js');

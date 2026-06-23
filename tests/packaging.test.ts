import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('package.json', root)), 'utf8'));

/** A tarball path that must never ship. Templates (.env.example, config.example.json) are fine. */
const looksSecret = (p: string): boolean =>
  /(^|\/)\.env$/.test(p) ||
  /(^|\/)\.env\.(?!example$)/.test(p) ||
  /(^|\/)servers\.json$/.test(p) ||
  /(^|\/)config\.json$/.test(p) ||
  /\.(db|pem|key|p12)$/.test(p) ||
  /(^|\/)\.vibecoders\//.test(p);

describe('packaging contract', () => {
  it('exposes a `vibecoders-mcp` bin that launches the server bundle', () => {
    // `npx -y vibecoders-mcp` and `claude mcp add … -- npx vibecoders-mcp` resolve the
    // bin named after the package. Without it the entire npx install path boots nothing.
    expect(pkg.bin?.['vibecoders-mcp']).toBe('dist/index.js');
  });

  it('the server bin is a launchable node script (carries the shebang)', () => {
    // build.mjs prepends `#!/usr/bin/env node`, so the bin runs directly under npx/PATH.
    const serverBin = fileURLToPath(new URL('dist/index.js', root));
    expect(existsSync(serverBin)).toBe(true);
    const firstLine = readFileSync(serverBin, 'utf8').split('\n', 1)[0];
    expect(firstLine).toBe('#!/usr/bin/env node');
  });

  it('keeps the plugin manifest version in lockstep with package.json', () => {
    // package.json is the single source of truth; the handshake version is injected from
    // it at build time (see build.mjs / the integration handshake test), and the static
    // plugin manifest is guarded here so the three can never silently drift.
    const plugin = JSON.parse(readFileSync(fileURLToPath(new URL('.claude-plugin/plugin.json', root)), 'utf8'));
    expect(plugin.version).toBe(pkg.version);
  });
});

describe('publish safety (no secrets ship)', () => {
  it('flags secret-bearing paths but never their templates', () => {
    // Proves the detector discriminates — otherwise the tarball check below is green-by-vacuum.
    expect(looksSecret('.env')).toBe(true);
    expect(looksSecret('dist/sub/.env.local')).toBe(true);
    expect(looksSecret('servers.json')).toBe(true);
    expect(looksSecret('config.json')).toBe(true);
    expect(looksSecret('data/store.db')).toBe(true);
    expect(looksSecret('.vibecoders/private/x.mjs')).toBe(true);
    expect(looksSecret('.env.example')).toBe(false);
    expect(looksSecret('config.example.json')).toBe(false);
    expect(looksSecret('dist/index.js')).toBe(false);
  });

  it('packs no secret-bearing file into the actual npm tarball', () => {
    // Inspect what `npm publish` would really ship (files[] is an allowlist, but a stray
    // glob or new entry could leak — this is the mechanical guarantee, not a checklist).
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: fileURLToPath(root),
      encoding: 'utf8',
    });
    const packed: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
    expect(packed.filter(looksSecret)).toEqual([]);
  });
});

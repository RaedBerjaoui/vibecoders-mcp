import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVibeConfig } from '../src/capabilities/config';
import { privateDir, loadOverlay, overlayStatusLine, type OverlayDeps } from '../src/overlay/loader';
import { text, errorText } from '../src/util/mcp';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

describe('VibeConfig.overlay', () => {
  it('accepts and round-trips the overlay block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-ov-cfg-'));
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ overlay: { enabled: false, dir: '/tmp/x' } }));
    const cfg = loadVibeConfig(path);
    expect(cfg.overlay?.enabled).toBe(false);
    expect(cfg.overlay?.dir).toBe('/tmp/x');
  });
});

describe('privateDir', () => {
  const empty = { capabilities: {} };

  it('prefers $VIBECODERS_PRIVATE_DIR over everything', () => {
    const got = privateDir({ ...empty, overlay: { dir: '/from/config' } }, {
      VIBECODERS_PRIVATE_DIR: '/from/env',
    } as NodeJS.ProcessEnv);
    expect(got).toBe(resolve('/from/env'));
  });

  it('falls back to overlay.dir from config', () => {
    const got = privateDir({ ...empty, overlay: { dir: '/from/config' } }, {} as NodeJS.ProcessEnv);
    expect(got).toBe(resolve('/from/config'));
  });

  it('defaults to <home>/.vibecoders/private (honoring VIBECODERS_HOME)', () => {
    expect(privateDir(empty, { VIBECODERS_HOME: '/custom/home' } as NodeJS.ProcessEnv)).toBe(
      join('/custom/home', '.vibecoders', 'private'),
    );
    expect(privateDir(empty, {} as NodeJS.ProcessEnv)).toBe(join(homedir(), '.vibecoders', 'private'));
  });
});

/** A stub MCP server that records registerTool() names — no stdio. */
function capture(): { server: McpServer; names: string[] } {
  const names: string[] = [];
  const server = {
    registerTool: (name: string) => {
      names.push(name);
    },
  } as unknown as McpServer;
  return { server, names };
}

const deps = (config: OverlayDeps['config']): OverlayDeps => ({
  log: { debug() {}, info() {}, warn() {}, error() {} },
  config,
  lane: { id: 'x', label: 'x@y', cwd: '/tmp', branch: 'y' },
  text,
  errorText,
});

/** Make a temp overlay dir with the given filenames (content irrelevant — importer is faked). */
function tmpOverlay(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-overlay-'));
  for (const f of files) writeFileSync(join(dir, f), '// fixture\n');
  return dir;
}

const nameOf = (url: string): string => url.split('/').pop() ?? url;

describe('loadOverlay', () => {
  it('is a no-op when the dir does not exist (fail-closed)', async () => {
    const { server } = capture();
    const res = await loadOverlay(server, deps({ capabilities: {} }), {
      env: { VIBECODERS_PRIVATE_DIR: join(tmpdir(), 'vibe-absent-zzz-404') } as NodeJS.ProcessEnv,
    });
    expect(res.exists).toBe(false);
    expect(res.loaded).toEqual([]);
  });

  it('is a no-op when overlay.enabled is false', async () => {
    const { server, names } = capture();
    const dir = tmpOverlay(['a.mjs']);
    const res = await loadOverlay(server, deps({ capabilities: {}, overlay: { enabled: false } }), {
      env: { VIBECODERS_PRIVATE_DIR: dir } as NodeJS.ProcessEnv,
      importer: async () => ({ register: (s: McpServer) => s.registerTool('nope', {}, async () => text('x')) }),
    });
    expect(res.enabled).toBe(false);
    expect(names).toEqual([]);
  });

  it('loads *.mjs/*.js in sorted order and invokes each register(server, deps)', async () => {
    const { server, names } = capture();
    const dir = tmpOverlay(['b.mjs', 'a.mjs', 'notes.txt']);
    const res = await loadOverlay(server, deps({ capabilities: {} }), {
      env: { VIBECODERS_PRIVATE_DIR: dir } as NodeJS.ProcessEnv,
      importer: async (url: string) => ({
        register: (s: McpServer, d: OverlayDeps) => s.registerTool(nameOf(url), {}, async () => d.text('ok')),
      }),
    });
    expect(res.loaded).toEqual(['a.mjs', 'b.mjs']); // sorted, .txt ignored
    expect(names).toEqual(['a.mjs', 'b.mjs']);
  });

  it('records a throwing module as failed but still loads the others', async () => {
    const { server, names } = capture();
    const dir = tmpOverlay(['bad.mjs', 'good.mjs']);
    const res = await loadOverlay(server, deps({ capabilities: {} }), {
      env: { VIBECODERS_PRIVATE_DIR: dir } as NodeJS.ProcessEnv,
      importer: async (url: string) => {
        if (nameOf(url) === 'bad.mjs') throw new Error('boom');
        return { register: (s: McpServer) => s.registerTool('good', {}, async () => text('ok')) };
      },
    });
    expect(res.loaded).toEqual(['good.mjs']);
    expect(names).toEqual(['good']);
    expect(res.failed).toEqual([{ file: 'bad.mjs', error: 'boom' }]);
  });

  it('records a module with no register() as failed', async () => {
    const { server } = capture();
    const dir = tmpOverlay(['nope.mjs']);
    const res = await loadOverlay(server, deps({ capabilities: {} }), {
      env: { VIBECODERS_PRIVATE_DIR: dir } as NodeJS.ProcessEnv,
      importer: async () => ({}),
    });
    expect(res.loaded).toEqual([]);
    expect(res.failed[0]?.file).toBe('nope.mjs');
    expect(res.failed[0]?.error).toMatch(/register/);
  });
});

describe('loadOverlay (real import)', () => {
  it('loads a committed .mjs fixture via the real importer and registers its tool', async () => {
    const { server, names } = capture();
    const fixtureDir = fileURLToPath(new URL('./fixtures/overlay', import.meta.url));
    const res = await loadOverlay(server, deps({ capabilities: {} }), {
      env: { VIBECODERS_PRIVATE_DIR: fixtureDir } as NodeJS.ProcessEnv,
    });
    expect(res.loaded).toContain('good.mjs');
    expect(res.failed).toEqual([]);
    expect(names).toContain('overlay_demo');
  });
});

describe('overlayStatusLine', () => {
  const base = { dir: '/d', enabled: true, exists: true, loaded: [], failed: [] };
  it('reports disabled', () => {
    expect(overlayStatusLine({ ...base, enabled: false })).toBe('Private overlay: off (overlay.enabled=false)');
  });
  it('reports an absent dir', () => {
    expect(overlayStatusLine({ ...base, exists: false })).toBe('Private overlay: none (/d)');
  });
  it('reports loaded and failed counts', () => {
    expect(
      overlayStatusLine({ ...base, loaded: ['a.mjs', 'b.mjs'], failed: [{ file: 'c.mjs', error: 'x' }] }),
    ).toBe('Private overlay: 2 loaded, 1 failed from /d');
  });
});

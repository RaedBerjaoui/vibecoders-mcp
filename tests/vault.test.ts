import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchVault, readVaultFile, registerVault } from '../src/vault/tools';
import type { Logger } from '../src/util/logger';

describe('searchVault', () => {
  it('ranks vault notes by query relevance and returns a snippet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-vault-'));
    writeFileSync(join(dir, 'a.md'), 'alpha beta gamma the quick decision about caching layers');
    writeFileSync(join(dir, 'b.md'), 'delta epsilon totally unrelated content here');
    const hits = await searchVault('caching decision', { dir });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.path).toBe('a.md');
    expect(hits[0]!.snippet.toLowerCase()).toContain('caching');
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds notes in nested subdirectories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-vault-'));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'deep.md'), 'kubernetes ingress troubleshooting notes');
    const hits = await searchVault('kubernetes ingress', { dir });
    expect(hits.some((h) => h.path.includes('deep.md'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('readVaultFile (path-guarded)', () => {
  it('reads a file inside the vault dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-vault-'));
    writeFileSync(join(dir, 'note.md'), 'hello vault');
    expect(await readVaultFile('note.md', { dir })).toContain('hello vault');
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a path that escapes the vault dir (traversal guard)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-vault-'));
    await expect(readVaultFile('../../etc/passwd', { dir })).rejects.toThrow(/escape|vault/i);
    rmSync(dir, { recursive: true, force: true });
  });
});

// T25 — registerVault receives an injected Logger; the vault_read catch path
// must warn (like memory/reference) so a failed read isn't silently swallowed
// into errorText. Drive the registered tool over real MCP transport.
describe('registerVault — vault_read logs its catch path via the injected logger', () => {
  it('warns when a read fails (e.g. a traversal attempt)', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

    const dir = mkdtempSync(join(tmpdir(), 'vibe-vault-'));
    const warnings: string[] = [];
    const log: Logger = { debug() {}, info() {}, warn: (...a) => warnings.push(a.join(' ')), error() {} };

    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerVault(server, { config: { dir }, log });

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0.0.0' });
    try {
      await Promise.all([server.connect(serverT), client.connect(clientT)]);
      await client.callTool({ name: 'vault_read', arguments: { path: '../../etc/passwd' } });
      expect(warnings.some((w) => w.includes('[vault_read]'))).toBe(true);
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { FEATURE_GROUPS } from '../src/capabilities/config';

const BIN = fileURLToPath(new URL('../bin/vibecoders.mjs', import.meta.url));
// The built server the CLI registers (node <DIST>). Present in the repo (dist/index.js).
const DIST = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const tmpCfg = () => join(mkdtempSync(join(tmpdir(), 'vibe-setup-')), 'config.json');
const run = (args: string[], cfgPath: string): string =>
  execFileSync('node', [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, VIBECODERS_CONFIG: cfgPath },
  });

describe('vibecoders setup (guided scaffold)', () => {
  it('lists each capability and its grant command, read-only', () => {
    const cfg = tmpCfg();
    const out = run(['setup'], cfg);
    expect(out).toContain('guided setup');
    expect(out).toContain('Memory (RAG)');
    expect(out).toContain('memory.embeddings true');
    rmSync(dirname(cfg), { recursive: true, force: true });
  });

  it('reflects enabled state from config when focusing a capability', () => {
    const cfg = tmpCfg();
    writeFileSync(cfg, JSON.stringify({ features: { memory: false } }));
    const out = run(['setup', 'memory'], cfg);
    expect(out).toContain('disabled');
    rmSync(dirname(cfg), { recursive: true, force: true });
  });

  it('lists the rag and skills capabilities in the walkthrough (regression: were omitted)', () => {
    const cfg = tmpCfg();
    const out = run(['setup'], cfg);
    expect(out).toContain('Design RAG');
    expect(out).toContain('Skills');
    rmSync(dirname(cfg), { recursive: true, force: true });
  });

  it('can focus rag / skills without an "unknown capability" error (exit 0)', () => {
    const cfg = tmpCfg();
    // run() throws if the CLI exits non-zero, so a returned string is itself proof
    // these are now recognized capabilities.
    expect(run(['setup', 'rag'], cfg)).toContain('Design RAG');
    expect(run(['setup', 'skills'], cfg)).toContain('Skills');
    rmSync(dirname(cfg), { recursive: true, force: true });
  });

  it('exits non-zero with a helpful message for an unknown capability', () => {
    const cfg = tmpCfg();
    let err: any;
    try {
      run(['setup', 'definitely-not-a-capability'], cfg);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.status).toBe(1);
    expect(String(err.stderr)).toContain('unknown capability');
    rmSync(dirname(cfg), { recursive: true, force: true });
  });
});

/** Top-level help text (no args). */
const help = (): string => {
  const cfg = tmpCfg();
  try {
    return run([], cfg);
  } finally {
    rmSync(dirname(cfg), { recursive: true, force: true });
  }
};

// T27 — the CLI must resolve `.env` from the SAME stable location as the server
// ($VIBECODERS_ENV → $VIBECODERS_HOME/.env), not just the repo root. Otherwise a
// globally-installed user's `vault list`/`doctor` reports keys the server can't
// see (or vice-versa). We point $VIBECODERS_ENV at a fixture and assert the CLI
// sees a key declared there.
describe('vibecoders CLI .env resolution (T27)', () => {
  const runWithEnv = (args: string[], cfgPath: string, envPath: string): string =>
    execFileSync('node', [BIN, ...args], {
      encoding: 'utf8',
      env: { ...process.env, VIBECODERS_CONFIG: cfgPath, VIBECODERS_ENV: envPath },
    });

  it('reports a key set in $VIBECODERS_ENV as present in `vault list`', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-env-'));
    const envFile = join(dir, 'secrets.env');
    const cfg = join(dir, 'config.json');
    writeFileSync(envFile, 'BRAVE_API_KEY=brv-xyz\n');
    const out = runWithEnv(['vault', 'list'], cfg, envFile);
    // BRAVE_API_KEY is declared in the stable .env → must show ✓, not ·.
    expect(out).toMatch(/✓ BRAVE_API_KEY/);
    // A key NOT in the file stays ·.
    expect(out).toMatch(/· TAVILY_API_KEY/);
    rmSync(dir, { recursive: true, force: true });
  });
});

// T28/T32 — the CLI `doctor` renders via the same shared logic as the MCP doctor
// (faithful copy in bin/vibecoders.mjs) and supports `--json` for scriptable,
// screen-reader-friendly output. Glyphs are word-paired (set/unset, on/off).
describe('vibecoders doctor — converged renderer + --json (T28/T32)', () => {
  it('word-pairs key glyphs (set/unset), not glyph-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-doc-'));
    const cfg = join(dir, 'config.json');
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'BRAVE_API_KEY=brv-xyz\n');
    const out = execFileSync('node', [BIN, 'doctor'], {
      encoding: 'utf8',
      env: { ...process.env, VIBECODERS_CONFIG: cfg, VIBECODERS_ENV: envFile, VIBECODERS_HOME: dir },
    });
    expect(out).toMatch(/set BRAVE_API_KEY/);
    expect(out).toMatch(/unset TAVILY_API_KEY/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('renders the static CLI driver header (never a connected client)', () => {
    // The live 'driver: <label>' line comes from the server's doctor tool; the CLI
    // has no driving MCP client, so its status view pins the "not connected" header.
    const dir = mkdtempSync(join(tmpdir(), 'vibe-hdr-'));
    const out = execFileSync('node', [BIN, 'doctor'], {
      encoding: 'utf8',
      env: { ...process.env, VIBECODERS_CONFIG: join(dir, 'config.json'), VIBECODERS_HOME: dir },
    });
    expect(out).toMatch(/Vibecoders — driver: not connected \(CLI status view\)/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits structured JSON with `--json` (scriptable)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-docj-'));
    const cfg = join(dir, 'config.json');
    const out = execFileSync('node', [BIN, 'doctor', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, VIBECODERS_CONFIG: cfg, VIBECODERS_ENV: join(dir, '.env'), VIBECODERS_HOME: dir },
    });
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('configured');
    expect(Array.isArray(parsed.keys)).toBe(true);
    expect(Array.isArray(parsed.providers)).toBe(true);
    expect(Array.isArray(parsed.servers)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

// T29 — the CLI doctor must resolve servers.json via the server's 3-tier order
// ($VIBECODERS_SERVERS → $VIBECODERS_HOME/servers.json → ./servers.json), so a
// user on the documented global path sees the same servers in `doctor` that
// Claude actually mounts — not "(none)".
describe('vibecoders doctor — servers.json 3-tier resolution (T29)', () => {
  it('reports servers from $VIBECODERS_SERVERS (explicit path wins)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-srv-'));
    const serversFile = join(dir, 'mine.json');
    writeFileSync(serversFile, JSON.stringify({ servers: { github: { command: 'x' }, supa: { command: 'y' } } }));
    const out = execFileSync('node', [BIN, 'doctor'], {
      encoding: 'utf8',
      env: { ...process.env, VIBECODERS_CONFIG: join(dir, 'config.json'), VIBECODERS_SERVERS: serversFile, VIBECODERS_HOME: dir },
    });
    expect(out).toContain('github');
    expect(out).toContain('supa');
    expect(out).toMatch(/Mounted MCP servers \(optional, 2\)/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports servers from $VIBECODERS_HOME/servers.json when no explicit path is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-srvh-'));
    writeFileSync(join(dir, 'servers.json'), JSON.stringify({ servers: { onlyglobal: { command: 'z' } } }));
    const env: Record<string, string | undefined> = {
      ...process.env,
      VIBECODERS_CONFIG: join(dir, 'config.json'),
      VIBECODERS_HOME: dir,
    };
    delete env.VIBECODERS_SERVERS;
    const out = execFileSync('node', [BIN, 'doctor'], { encoding: 'utf8', env });
    expect(out).toContain('onlyglobal');
    rmSync(dir, { recursive: true, force: true });
  });
});

// T31 — `config set <dotted.key>` validates the key against the known key space
// (derived from FEATURE_GROUPS + the config schema). A typo no longer silently
// no-ops: it warns (non-fatally, with a "did you mean") while known keys pass
// through cleanly.
describe('vibecoders config set — key validation (T31)', () => {
  // spawnSync captures stderr even on a zero exit (the warning is non-fatal).
  const runCfg = (args: string[], cfgPath: string) => {
    const r = spawnSync('node', [BIN, ...args], {
      encoding: 'utf8',
      env: { ...process.env, VIBECODERS_CONFIG: cfgPath },
    });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
  };

  it('accepts a known key with no warning (features.device)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-set-'));
    const cfg = join(dir, 'config.json');
    const r = runCfg(['config', 'set', 'features.device', 'true'], cfg);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/unknown (config )?key/i);
    expect(r.stdout).toMatch(/Set features\.device/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts known memory / reference keys without warning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-set2-'));
    const cfg = join(dir, 'config.json');
    expect(runCfg(['config', 'set', 'memory.embeddings', 'true'], cfg).stderr).not.toMatch(/unknown (config )?key/i);
    expect(runCfg(['config', 'set', 'reference.allowPrivateHosts', 'false'], cfg).stderr).not.toMatch(/unknown (config )?key/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts the delegation.envMode key without warning (env-leak fix)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-set-deleg-'));
    const cfg = join(dir, 'config.json');
    const r = runCfg(['config', 'set', 'delegation.envMode', 'inherit'], cfg);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/unknown (config )?key/i);
    expect(r.stdout).toMatch(/Set delegation\.envMode/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns (non-fatally) on a typo and suggests the nearest known key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-set3-'));
    const cfg = join(dir, 'config.json');
    const r = runCfg(['config', 'set', 'features.devce', 'true'], cfg); // typo: devce
    expect(r.status).toBe(0); // non-fatal — does NOT exit 1
    expect(r.stderr).toMatch(/unknown (config )?key/i);
    expect(r.stderr).toMatch(/did you mean/i);
    expect(r.stderr).toMatch(/features\.device/); // nearest suggestion
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns on a typo in a known section key (memory.embedings)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-set4-'));
    const cfg = join(dir, 'config.json');
    const r = runCfg(['config', 'set', 'memory.embedings', 'true'], cfg); // typo
    expect(r.stderr).toMatch(/unknown (config )?key/i);
    expect(r.stderr).toMatch(/memory\.embeddings/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('allows free-form capabilities.* keys (record schema) without warning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-set5-'));
    const cfg = join(dir, 'config.json');
    const r = runCfg(['config', 'set', 'capabilities.image_gen.provider', 'openai-api'], cfg);
    expect(r.stderr).not.toMatch(/unknown (config )?key/i);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('vibecoders help', () => {
  it('lists the core commands (init / register / doctor / handoff / vault / config)', () => {
    const out = help();
    expect(out).toContain('init');
    expect(out).toContain('register');
    expect(out).toContain('doctor');
    expect(out).toContain('handoff recall');
    expect(out).toContain('vault set');
    expect(out).toContain('config set');
    // register is now multi-client — the help must surface the --client flag.
    expect(out).toContain('--client');
    expect(out).toMatch(/claude\|codex\|gemini\|all/);
  });

  it('still errors (exit 1) on a genuinely unknown command', () => {
    const cfg = tmpCfg();
    let err: any;
    try {
      run(['definitely-not-a-command'], cfg);
    } catch (e) {
      err = e;
    }
    expect(err?.status).toBe(1);
    expect(String(err.stderr)).toContain('Unknown command');
    rmSync(dirname(cfg), { recursive: true, force: true });
  });
});

// The CLI's accepted `features.<name>` keys must stay in lockstep with the ONE
// source of truth in src (FEATURE_GROUPS). We assert parity by CLI behavior —
// every group name is a known key (no warning), and a name that isn't a group
// warns. This catches drift the moment a new group is added to src but not to the
// hand-maintained FEATURE_NAMES list in bin/vibecoders.mjs (the `rag`/`skills`
// bug this change fixes).
describe('vibecoders config set — features parity with src FEATURE_GROUPS', () => {
  const runCfg = (args: string[], cfgPath: string) => {
    const r = spawnSync('node', [BIN, ...args], {
      encoding: 'utf8',
      env: { ...process.env, VIBECODERS_CONFIG: cfgPath },
    });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
  };

  it('accepts every FEATURE_GROUPS name as features.<name> without warning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-parity-'));
    for (const g of FEATURE_GROUPS) {
      const r = runCfg(['config', 'set', `features.${g.name}`, 'true'], join(dir, `${g.name}.json`));
      expect(r.status, `features.${g.name} should exit 0`).toBe(0);
      expect(r.stderr, `features.${g.name} should be a KNOWN key`).not.toMatch(/unknown (config )?key/i);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts the newly-added rag and skills groups (regression: were unknown)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-ragskills-'));
    expect(runCfg(['config', 'set', 'features.rag', 'false'], join(dir, 'a.json')).stderr).not.toMatch(
      /unknown (config )?key/i,
    );
    expect(runCfg(['config', 'set', 'features.skills', 'true'], join(dir, 'b.json')).stderr).not.toMatch(
      /unknown (config )?key/i,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts host.adaptive / host.force (host pinning keys)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-host-'));
    expect(runCfg(['config', 'set', 'host.adaptive', 'false'], join(dir, 'a.json')).stderr).not.toMatch(
      /unknown (config )?key/i,
    );
    expect(runCfg(['config', 'set', 'host.force', 'codex'], join(dir, 'b.json')).stderr).not.toMatch(
      /unknown (config )?key/i,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('still warns on a features.<name> that is not a real group', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-nogroup-'));
    const r = runCfg(['config', 'set', 'features.zzz', 'true'], join(dir, 'z.json'));
    expect(r.stderr).toMatch(/unknown (config )?key/i);
    rmSync(dir, { recursive: true, force: true });
  });
});

// register is multi-client: `vibecoders register [--client claude|codex|gemini|all]`.
// We drive it with a temp PATH shim of stub executables that record their argv to a
// file, so `hasCli` + the actual `mcp add` resolve to the stubs (never the real CLIs)
// and we can assert the exact argv each client is invoked with.
describe('vibecoders register — multi-client (--client)', () => {
  /** An executable stub that records its argv (one per line) to `outFile`, then exits `code`. */
  const writeArgvStub = (dir: string, name: string, outFile: string, code = 0) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "$@" > "${outFile}"\nexit ${code}\n`);
    chmodSync(p, 0o755);
  };
  const recordedArgv = (outFile: string): string[] =>
    readFileSync(outFile, 'utf8').split('\n').filter((l) => l.length > 0);
  /** Run the CLI with an absolute node (PATH-independent) + a custom PATH/env. */
  const reg = (args: string[], pathVal: string, cfgDir: string) =>
    spawnSync(process.execPath, [BIN, 'register', ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: pathVal, VIBECODERS_CONFIG: join(cfgDir, 'cfg.json') },
    });
  // Shim prepended to the real PATH so the stubs win over any real CLI on this box.
  const shimPath = (shim: string) => `${shim}:${process.env.PATH}`;

  it('--client codex → `codex mcp add vibecoders -- node <DIST>`', () => {
    const shim = mkdtempSync(join(tmpdir(), 'vibe-reg-codex-'));
    const out = join(shim, 'codex.argv');
    writeArgvStub(shim, 'codex', out);
    const r = reg(['--client', 'codex'], shimPath(shim), shim);
    expect(r.status).toBe(0);
    expect(recordedArgv(out)).toEqual(['mcp', 'add', 'vibecoders', '--', 'node', DIST]);
    expect(r.stdout).toContain('Registered vibecoders with Codex.');
    rmSync(shim, { recursive: true, force: true });
  });

  it('--client gemini → `gemini mcp add vibecoders node <DIST>` (positional, no `--`)', () => {
    const shim = mkdtempSync(join(tmpdir(), 'vibe-reg-gem-'));
    const out = join(shim, 'gemini.argv');
    writeArgvStub(shim, 'gemini', out);
    const r = reg(['--client', 'gemini'], shimPath(shim), shim);
    expect(r.status).toBe(0);
    expect(recordedArgv(out)).toEqual(['mcp', 'add', 'vibecoders', 'node', DIST]);
    expect(r.stdout).toContain('Registered vibecoders with Gemini CLI.');
    rmSync(shim, { recursive: true, force: true });
  });

  it('defaults to claude (user scope) with no --client — backwards compatible', () => {
    const shim = mkdtempSync(join(tmpdir(), 'vibe-reg-claude-'));
    const out = join(shim, 'claude.argv');
    writeArgvStub(shim, 'claude', out);
    const r = reg([], shimPath(shim), shim);
    expect(r.status).toBe(0);
    expect(recordedArgv(out)).toEqual(['mcp', 'add', 'vibecoders', '-s', 'user', '--', 'node', DIST]);
    expect(r.stdout).toContain('Registered "vibecoders" with Claude Code');
    rmSync(shim, { recursive: true, force: true });
  });

  it('--client all registers every installed client and exits 0', () => {
    const shim = mkdtempSync(join(tmpdir(), 'vibe-reg-all-'));
    const outs = {
      codex: join(shim, 'codex.argv'),
      gemini: join(shim, 'gemini.argv'),
      claude: join(shim, 'claude.argv'),
    };
    writeArgvStub(shim, 'codex', outs.codex);
    writeArgvStub(shim, 'gemini', outs.gemini);
    writeArgvStub(shim, 'claude', outs.claude);
    const r = reg(['--client', 'all'], shimPath(shim), shim);
    expect(r.status).toBe(0);
    expect(recordedArgv(outs.codex)).toEqual(['mcp', 'add', 'vibecoders', '--', 'node', DIST]);
    expect(recordedArgv(outs.gemini)).toEqual(['mcp', 'add', 'vibecoders', 'node', DIST]);
    expect(recordedArgv(outs.claude)).toEqual(['mcp', 'add', 'vibecoders', '-s', 'user', '--', 'node', DIST]);
    expect(r.stdout).toMatch(/3\/3 registered/);
    rmSync(shim, { recursive: true, force: true });
  });

  it('--client all skips a client whose binary is absent (partial install)', () => {
    const shim = mkdtempSync(join(tmpdir(), 'vibe-reg-partial-'));
    const codexOut = join(shim, 'codex.argv');
    writeArgvStub(shim, 'codex', codexOut); // only codex installed
    // Minimal PATH: shim (codex) + /usr/bin:/bin for `which`/`sh`; gemini+claude absent.
    const r = reg(['--client', 'all'], `${shim}:/usr/bin:/bin`, shim);
    expect(r.status).toBe(0);
    expect(recordedArgv(codexOut)).toEqual(['mcp', 'add', 'vibecoders', '--', 'node', DIST]);
    expect(r.stdout).toMatch(/skipped Gemini/);
    expect(r.stdout).toMatch(/skipped Claude/);
    expect(r.stdout).toMatch(/1\/1 registered/);
    rmSync(shim, { recursive: true, force: true });
  });

  it('--client all exits 1 only when EVERY attempt fails', () => {
    const shim = mkdtempSync(join(tmpdir(), 'vibe-reg-allfail-'));
    // All three present but each exits non-zero → every attempt fails → exit 1.
    writeArgvStub(shim, 'codex', join(shim, 'codex.argv'), 1);
    writeArgvStub(shim, 'gemini', join(shim, 'gemini.argv'), 1);
    writeArgvStub(shim, 'claude', join(shim, 'claude.argv'), 1);
    const r = reg(['--client', 'all'], shimPath(shim), shim);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/0\/3 registered/);
    rmSync(shim, { recursive: true, force: true });
  });

  it('errors (exit 1) with the manual command when an explicit client is not installed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-reg-missing-'));
    // /usr/bin:/bin resolves `which` but not codex → treated as not installed.
    const r = reg(['--client', 'codex'], '/usr/bin:/bin', dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not found on PATH/);
    // The printed manual command quotes the dist path so it survives spaces.
    expect(r.stderr).toContain('codex mcp add vibecoders -- node "');
    rmSync(dir, { recursive: true, force: true });
  });

  it('errors (exit 1) on an unknown --client', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibe-reg-bogus-'));
    const r = reg(['--client', 'notaclient'], process.env.PATH ?? '', dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown --client/);
    expect(r.stderr).toMatch(/claude, codex, gemini, all/);
    rmSync(dir, { recursive: true, force: true });
  });
});

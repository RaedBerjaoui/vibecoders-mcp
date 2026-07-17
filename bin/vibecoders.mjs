#!/usr/bin/env node
/**
 * Vibecoders CLI — setup + secret vault. Self-contained (no build needed).
 * Secrets live in the macOS Keychain; values are never printed or written to
 * the repo. Everything it configures is OPTIONAL — the server runs with none.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import readline from 'node:readline';

const SERVICE = 'vibecoders-mcp';
// Keep in sync with src/config/env.ts SECRETS — the keys vibecoders can resolve.
const SECRETS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'BRAVE_API_KEY',
  'TAVILY_API_KEY',
  'GITHUB_TOKEN',
  'VERCEL_TOKEN',
  'SUPABASE_ACCESS_TOKEN',
];
const PROVIDERS = ['codex', 'gemini', 'claude'];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist', 'index.js');
const IS_MAC = process.platform === 'darwin';

// ---- user config (~/.vibecoders/config.json) — non-secret, customizable ----
function configPath() {
  if (process.env.VIBECODERS_CONFIG) return process.env.VIBECODERS_CONFIG;
  const home = process.env.VIBECODERS_HOME ?? join(homedir(), '.vibecoders');
  return join(home, 'config.json');
}

// T27 — resolve `.env` from the SAME stable location as the server
// (src/config/env.ts resolveEnvPath): $VIBECODERS_ENV → $VIBECODERS_HOME/.env,
// with the repo-root `.env` as a final fallback. Keeps CLI ⇄ server in agreement
// so a globally-registered server and `vault list`/`doctor` never disagree.
function resolveEnvPath() {
  if (process.env.VIBECODERS_ENV) return process.env.VIBECODERS_ENV;
  const home = process.env.VIBECODERS_HOME ?? join(homedir(), '.vibecoders');
  return join(home, '.env');
}
function loadConfigFile() {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}
function saveConfigFile(cfg) {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`);
  return p;
}
/** Coerce a CLI string to bool/number/null/JSON where it clearly is one. */
function coerceValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
// T31 — the known config key space, so `config set` can warn on a typo instead
// of silently writing an inert key. DERIVED in spirit from FEATURE_GROUPS + the
// Zod schema in src/capabilities/config.ts (kept in sync here because this .mjs
// can't import the TS schema — same pattern as the SECRETS array above).
const FEATURE_NAMES = ['memory', 'reference', 'projectContext', 'tasks', 'device', 'vault', 'rag', 'skills'];
const KNOWN_CONFIG_KEYS = [
  ...FEATURE_NAMES.map((n) => `features.${n}`),
  'memory.embeddings',
  'memory.embedProvider',
  'memory.embedModel',
  'memory.defaultScope',
  'memory.alpha',
  'reference.allowPrivateHosts',
  'reference.allowHosts',
  'reference.maxBytes',
  'vault.dir',
  'vault.maxFiles',
  'overlay.enabled',
  'overlay.dir',
  'delegation.envMode',
  'host.adaptive',
  'host.force',
];
// `capabilities.*` is a free-form record in the schema (per-capability provider +
// settings), so any dotted key under it is allowed without a warning.
const FREEFORM_PREFIXES = ['capabilities.'];

/** Levenshtein distance — for the "did you mean" suggestion on a typo'd key. */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/**
 * Validate a dotted config key against the known key space. Returns
 * { known: true } for a known/free-form key, or { known:false, suggestion } for
 * an unknown one (suggestion = nearest known key, if reasonably close).
 */
function validateConfigKey(key) {
  if (KNOWN_CONFIG_KEYS.includes(key)) return { known: true };
  if (FREEFORM_PREFIXES.some((p) => key.startsWith(p) && key.length > p.length)) return { known: true };
  let best;
  let bestDist = Infinity;
  for (const k of KNOWN_CONFIG_KEYS) {
    const d = editDistance(key, k);
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  // Only suggest when it's a plausible typo (close in edit distance), not random.
  const suggestion = best !== undefined && bestDist <= Math.max(2, Math.ceil(key.length / 3)) ? best : undefined;
  return { known: false, suggestion };
}

function setDeep(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}
// Generic dotted-key read for the `config get <key>` DISPLAY only.
function getDeep(obj, dotted) {
  return dotted.split('.').reduce((cur, k) => (cur == null ? undefined : cur[k]), obj);
}

function featureState(cfg, id, defaultOn) {
  const v = cfg?.features?.[id];
  return typeof v === 'boolean' ? v : defaultOn;
}

// ---- per-project handoff (<git-root>/HANDOFF.md) --------------------------
// The `handoff` subcommand below is a tiny, self-contained helper for the
// per-project resume doc: walk up from cwd to the git root, then HANDOFF.md
// lives there. Pure path logic, self-contained.

/** Nearest ancestor dir of `startDir` containing a `.git`, or undefined (no repo). */
function gitRoot(startDir) {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // hit filesystem root, no repo → refuse
    dir = parent;
  }
}

/** Resolve a project's handoff: { dir, path, name }, or undefined for a non-repo cwd. */
function projectHandoff(cwd) {
  const root = gitRoot(cwd);
  if (!root) return undefined; // non-repo cwd → unsupported, no stray HANDOFF.md
  const name = root.split('/').filter(Boolean).pop() ?? 'project';
  return { dir: root, path: join(root, 'HANDOFF.md'), name };
}

function guidedSetup(focus) {
  const cfg = loadConfigFile();
  const groups = [
    { id: 'memory', label: 'Memory (RAG)', defaultOn: true,
      grant: 'on by default · optional embeddings: vibecoders config set memory.embeddings true (needs OPENAI_API_KEY or GEMINI_API_KEY)' },
    { id: 'reference', label: 'Reference (web read)', defaultOn: true, grant: 'on by default' },
    { id: 'projectContext', label: 'Project context', defaultOn: true, grant: 'on by default' },
    { id: 'tasks', label: 'Background tasks (async delegation)', defaultOn: true, grant: 'on by default' },
    { id: 'rag', label: 'Design RAG (anti-AI-design tools)', defaultOn: true, grant: 'on by default' },
    { id: 'skills', label: 'Skills (curated skill playbooks)', defaultOn: true, grant: 'on by default' },
    { id: 'device', label: 'Device search + chat history (macOS · personal data)', defaultOn: false,
      grant: 'vibecoders config set features.device true' },
    { id: 'vault', label: 'Notes vault (personal data)', defaultOn: false,
      grant: 'vibecoders config set features.vault true && vibecoders config set vault.dir ~/notes' },
  ];
  const show = focus ? groups.filter((g) => g.id === focus) : groups;
  if (focus && show.length === 0) {
    return fail(`unknown capability: ${focus} (try: ${groups.map((g) => g.id).join(', ')})`);
  }
  console.log('Vibecoders — guided setup');
  console.log('Walks each capability and shows the exact command to grant it on THIS machine.');
  console.log('Read-only: nothing is written automatically; run the printed commands. Safe to re-run.\n');
  for (const g of show) {
    const on = featureState(cfg, g.id, g.defaultOn);
    console.log(`• ${g.label} — ${on ? 'ENABLED' : 'disabled'}`);
    console.log(`    grant: ${g.grant}\n`);
  }
}

function keychainHas(name) {
  if (!IS_MAC) return false;
  try {
    execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}
function keychainSet(name, value) {
  execFileSync('security', ['add-generic-password', '-s', SERVICE, '-a', name, '-w', value, '-U'], {
    stdio: 'ignore',
  });
}
function keychainRm(name) {
  try {
    execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', name], { stdio: 'ignore' });
  } catch {
    /* absent */
  }
}
function envHas(name) {
  if (process.env[name]) return true;
  // Stable location first (matches the server), then repo-root .env as fallback.
  const candidates = [resolveEnvPath(), join(ROOT, '.env')];
  for (const envFile of candidates) {
    if (existsSync(envFile) && new RegExp(`^\\s*${name}\\s*=\\s*\\S`, 'm').test(readFileSync(envFile, 'utf8'))) {
      return true;
    }
  }
  return false;
}
const isSet = (name) => keychainHas(name) || envHas(name);

function hasCli(cmd) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function promptHidden(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = () => {};
    process.stdout.write(query);
    rl.question('', (a) => {
      rl.close();
      process.stdout.write('\n');
      resolve(a.trim());
    });
  });
}

// T29 — resolve servers.json the SAME 3-tier way the server does
// (src/gateway/registry.ts resolveServersPath): $VIBECODERS_SERVERS →
// $VIBECODERS_HOME/servers.json → ./servers.json (repo root for the CLI). Keeps
// the CLI doctor reporting the same servers the server actually mounts.
function resolveServersPathCli() {
  const fromEnv = process.env.VIBECODERS_SERVERS;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const home = process.env.VIBECODERS_HOME ?? join(homedir(), '.vibecoders');
  const global = join(home, 'servers.json');
  if (existsSync(global)) return global;
  return join(ROOT, 'servers.json');
}

// T28 — gather CLI status as the SAME plain data shape the server's renderDoctor
// consumes (src/index.ts DoctorData), so both render identically. The CLI knows
// only the pre-registration subset: delegation CLIs, mounted servers, keys, build.
function buildStatusData() {
  const serversFile = resolveServersPathCli();
  let servers = [];
  if (existsSync(serversFile)) {
    try {
      servers = Object.keys(JSON.parse(readFileSync(serversFile, 'utf8')).servers ?? {});
    } catch {
      /* fail-soft: a broken servers file means "none" (mirrors the server) */
    }
  }
  return {
    providers: PROVIDERS.filter(hasCli).map((id) => ({ id, label: id, billing: 'your subscription' })),
    servers,
    keys: SECRETS.map((name) => ({ name, present: isSet(name) })),
    capabilities: [],
    toolGroups: [],
    build: { present: existsSync(DIST), path: DIST },
  };
}

// T33 — "configured" = any delegation CLI, mounted server, or present key. Drives
// the all-empty next step and the JSON `configured` flag. (Faithful copy of the
// server's isAnythingConfigured for the CLI's data subset.)
function isAnythingConfigured(d) {
  return d.providers.length > 0 || d.servers.length > 0 || d.keys.some((k) => k.present);
}

// T28/T32/T33 — faithful copy of src/index.ts renderDoctor, for the CLI's data
// subset. Word-pairs every glyph (set/unset) so it's screen-reader-friendly and
// scriptable; appends the all-empty call-to-action.
function renderStatus(d) {
  const lines = [
    // The CLI never has a driving MCP client — the live 'driver: <label>' line
    // comes from the server's doctor tool. This is the static CLI status view.
    'Vibecoders — driver: not connected (CLI status view)\n',
    'Delegation CLIs (optional — delegate bills via your subscription, not an API):',
  ];
  if (d.providers.length === 0) {
    lines.push('  (none — install codex, gemini, or claude to delegate on your subscription)');
  } else {
    for (const p of PROVIDERS) lines.push(`  ${hasCli(p) ? '✓ on' : '· off'} ${p}`);
  }

  lines.push(
    `\nMounted MCP servers (optional, ${d.servers.length}): ${
      d.servers.join(', ') || '(none — copy servers.example.json → servers.json)'
    }`,
  );

  lines.push('\nAPI keys (optional — only for downstream servers that need one):');
  for (const k of d.keys) lines.push(`  ${k.present ? '✓ set' : '· unset'} ${k.name}`);

  lines.push(
    `\nBuild: ${d.build.present ? '✓ built — dist/index.js present' : '· not built (run: vibecoders init)'}`,
  );

  if (!isAnythingConfigured(d)) {
    lines.push(
      '\nNext step: install a delegation CLI (codex / gemini / claude) — nothing else is required.',
    );
  }
  return lines.join('\n');
}

// T32 — structured, scriptable status (the `--json` variant). Mirrors the
// server's renderDoctorJson shape.
function renderStatusJson(d) {
  return {
    capabilities: d.capabilities,
    providers: d.providers,
    servers: d.servers,
    keys: d.keys,
    toolGroups: d.toolGroups,
    build: d.build,
    configured: isAnythingConfigured(d),
  };
}

function status(json = false) {
  const data = buildStatusData();
  console.log(json ? JSON.stringify(renderStatusJson(data), null, 2) : renderStatus(data));
}

// ---- register: add this server to a coding agent's MCP config ---------------
// Multi-client. Each entry knows the binary, the exact argv (verified against the
// local CLIs — claude, codex-cli, gemini), the manual fallback command, and the
// lines to print on success. `--client all` fans out over the installed ones.
const REGISTRARS = {
  claude: {
    label: 'Claude Code',
    bin: 'claude',
    argv: ['mcp', 'add', 'vibecoders', '-s', 'user', '--', 'node', DIST],
    manual: `claude mcp add vibecoders -s user -- node "${DIST}"`,
    success: [
      '\nRegistered "vibecoders" with Claude Code (user scope).',
      'Restart Claude Code, then ask it to run `doctor`.',
    ],
  },
  codex: {
    label: 'Codex',
    bin: 'codex',
    argv: ['mcp', 'add', 'vibecoders', '--', 'node', DIST],
    manual: `codex mcp add vibecoders -- node "${DIST}"`,
    success: [
      'Registered vibecoders with Codex.',
      'Restart: start a new Codex session.',
      'Tip: for long delegate calls raise the MCP tool timeout — in ~/.codex/config.toml under [mcp_servers.vibecoders]: tool_timeout_sec = 1200',
    ],
  },
  gemini: {
    label: 'Gemini CLI',
    bin: 'gemini',
    argv: ['mcp', 'add', 'vibecoders', 'node', DIST],
    manual: `gemini mcp add vibecoders node "${DIST}"`,
    success: [
      'Registered vibecoders with Gemini CLI.',
      'Restart: start a new Gemini CLI session.',
    ],
  },
};

/** Parse `--client <id>` / `--client=<id>` from the args after `register`. Default claude. */
function parseClientFlag(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--client') return args[i + 1]; // may be undefined → invalid
    if (a.startsWith('--client=')) return a.slice('--client='.length);
  }
  return 'claude';
}

/** Run one client's `mcp add` (binary assumed present). Prints success lines or the fallback. */
function runRegistrar(spec) {
  try {
    execFileSync(spec.bin, spec.argv, { stdio: 'inherit' });
    for (const line of spec.success) console.log(line);
    return true;
  } catch {
    console.log(`Could not run \`${spec.bin} mcp add\` automatically. Run this yourself:`);
    console.log(`  ${spec.manual}`);
    return false;
  }
}

function register(args) {
  if (!existsSync(DIST)) return fail('Not built yet. Run `vibecoders init` (or `npm run build`) first.');
  const client = parseClientFlag(args);
  const valid = new Set([...Object.keys(REGISTRARS), 'all']);
  if (!client || !valid.has(client)) {
    return fail(`register: unknown --client '${client ?? ''}' (expected: claude, codex, gemini, all)`);
  }

  if (client === 'all') {
    // Try each installed client (PROVIDERS order); skip those whose binary is absent.
    let attempts = 0;
    let registered = 0;
    for (const id of PROVIDERS) {
      const spec = REGISTRARS[id];
      if (!hasCli(spec.bin)) {
        console.log(`· skipped ${spec.label} (${spec.bin} not installed)`);
        continue;
      }
      attempts++;
      if (runRegistrar(spec)) registered++;
    }
    if (attempts === 0) {
      console.log('\nNo delegation CLIs found (codex / gemini / claude). Install one, then re-run.');
      return;
    }
    console.log(`\nregister --client all: ${registered}/${attempts} registered.`);
    // Non-zero exit only if EVERY attempt failed.
    if (registered === 0) process.exit(1);
    return;
  }

  // A single, explicitly-chosen client. Missing binary → clear error + manual cmd, exit 1.
  // (Binary present but the command fails → runRegistrar prints the fallback, no exit 1 —
  // preserves the original claude behavior.)
  const spec = REGISTRARS[client];
  if (!hasCli(spec.bin)) {
    return fail(`register: '${spec.bin}' not found on PATH. Install it, or run this yourself:\n  ${spec.manual}`);
  }
  runRegistrar(spec);
}

function initSetup() {
  console.log('Vibecoders MCP — setup\n');
  if (!existsSync(DIST)) {
    console.log('Building dist/index.js …');
    try {
      execFileSync('node', [join(ROOT, 'build.mjs')], { cwd: ROOT, stdio: 'inherit' });
    } catch {
      return fail('Build failed. Run `npm install`, then `vibecoders init` again.');
    }
  }
  console.log('');
  status();
  console.log('\nRegister with your coding agent (one command):');
  console.log('  vibecoders register [--client claude|codex|gemini|all]   (default claude)');
  console.log(`  …or manually:  claude mcp add vibecoders -s user -- node "${DIST}"`);
  console.log('\nIt runs with NO keys, servers, or CLIs. Add a delegation CLI');
  console.log('(codex / gemini / claude) to offload work on your subscription.');
}

async function main() {
  const [cmd, sub, arg] = process.argv.slice(2);
  switch (cmd) {
    case 'vault': {
      if (sub === 'set') {
        if (!arg) return fail('usage: vibecoders vault set <NAME>');
        if (!IS_MAC) {
          return fail(
            `Keychain vault is macOS-only. On this OS, add the key to .env (git-ignored):\n  echo "${arg}=YOUR_VALUE" >> .env`,
          );
        }
        const value = process.stdin.isTTY
          ? await promptHidden(`Value for ${arg} (hidden): `)
          : readFileSync(0, 'utf8').trim();
        if (!value) return fail('empty — nothing stored');
        keychainSet(arg, value);
        console.log(`Stored ${arg} in the macOS Keychain (service "${SERVICE}").`);
      } else if (sub === 'rm') {
        if (!arg) return fail('usage: vibecoders vault rm <NAME>');
        if (!IS_MAC) return fail('Keychain vault is macOS-only. Remove the key from your .env instead.');
        keychainRm(arg);
        console.log(`Removed ${arg} from the Keychain (if present).`);
      } else if (sub === 'list') {
        for (const k of SECRETS) console.log(`  ${isSet(k) ? '✓' : '·'} ${k}`);
      } else {
        return fail('usage: vibecoders vault <set|rm|list> [NAME]');
      }
      break;
    }
    case 'config': {
      // Customize non-secret behavior (features, memory, reference). Secrets stay
      // in the Keychain/.env — never here.
      if (sub === 'path') {
        console.log(configPath());
      } else if (sub === 'get') {
        const cfg = loadConfigFile();
        const val = arg ? getDeep(cfg, arg) : cfg;
        console.log(val === undefined ? '(unset)' : JSON.stringify(val, null, 2));
      } else if (sub === 'set') {
        const value = process.argv.slice(2)[3]; // [config, set, <key>, <value>]
        if (!arg || value === undefined) return fail('usage: vibecoders config set <dotted.key> <value>');
        // T31 — warn (non-fatally) on an unknown key so a typo doesn't silently
        // write an inert key. Known/free-form keys pass through cleanly.
        const check = validateConfigKey(arg);
        if (!check.known) {
          const hint = check.suggestion ? ` — did you mean '${check.suggestion}'?` : '';
          console.error(`Warning: unknown config key '${arg}'${hint}`);
          console.error('(Writing it anyway, but the server may ignore it. See: vibecoders config get)');
        }
        const cfg = loadConfigFile();
        setDeep(cfg, arg, coerceValue(value));
        const p = saveConfigFile(cfg);
        console.log(`Set ${arg} = ${JSON.stringify(coerceValue(value))}  →  ${p}`);
      } else {
        return fail(
          [
            'usage: vibecoders config <path|get|set>',
            '  config path                       print the config file path',
            '  config get [dotted.key]           print the whole config or one key',
            '  config set <dotted.key> <value>   set a key (value coerced to bool/number/JSON)',
            '',
            'examples:',
            '  vibecoders config set memory.embeddings true',
            '  vibecoders config set memory.embedProvider openai',
            '  vibecoders config set memory.defaultScope global',
            '  vibecoders config set reference.allowPrivateHosts false',
          ].join('\n'),
        );
      }
      break;
    }
    case 'setup':
      guidedSetup(sub);
      break;
    case 'init':
      initSetup();
      break;
    case 'register':
      register(process.argv.slice(3));
      break;
    case 'doctor': {
      // `vibecoders doctor [--json]` — structured output for scripts/CI/a11y.
      const wantsJson = process.argv.slice(2).includes('--json');
      status(wantsJson);
      break;
    }
    case 'handoff': {
      // Per-project handoff: lives at <git-root>/HANDOFF.md, in the codebase it's
      // about. Pure path helper above — no external module needed.
      const proj = projectHandoff(process.cwd());
      if (!proj) {
        // Non-repo cwd → gitRoot refuses: no stray HANDOFF.md. Recall is a clean
        // no-op; write/where refuse rather than crash on undefined.
        if (sub === 'recall' || sub === undefined) {
          console.log('No handoff: this directory is not inside a git repo.');
          break;
        }
        return fail('handoff: this directory is not inside a git repo (no handoff location).');
      }
      if (sub === 'recall' || sub === undefined) {
        if (existsSync(proj.path)) process.stdout.write(readFileSync(proj.path, 'utf8'));
        else console.log(`No handoff yet for ${proj.name} (${proj.path}).`);
      } else if (sub === 'write') {
        const body = process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
        if (!body.trim()) return fail('handoff write: pipe the handoff body on stdin');
        mkdirSync(dirname(proj.path), { recursive: true });
        writeFileSync(proj.path, body);
        console.log(`Handoff saved → ${proj.path}`);
      } else if (sub === 'where') {
        console.log(proj.path);
      } else {
        return fail('usage: vibecoders handoff <recall|write|where>');
      }
      break;
    }
    case 'onboard':
      console.log('Vibecoders MCP — setup (everything below is optional)\n');
      status();
      console.log('\nFastest path:');
      console.log('  vibecoders init        build + status');
      console.log('  vibecoders register    register with a coding agent (default claude)');
      console.log('                         --client claude|codex|gemini|all to pick one, or all');
      console.log('\nOptional extras:');
      console.log('  • Delegate on your plan: install a CLI (codex / gemini / claude)');
      console.log('  • Mount other MCPs:      cp servers.example.json servers.json');
      console.log(
        process.platform === 'darwin'
          ? '  • API key (if a server needs one):  vibecoders vault set <NAME>  (or add <NAME>=... to .env)'
          : '  • API key (if a server needs one):  add <NAME>=... to your .env',
      );
      break;
    case 'version':
    case '--version':
    case '-v': {
      const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
      console.log(`vibecoders ${pkg.version}`);
      break;
    }
    default: {
      const help = [
        'vibecoders <command>',
        '',
        '  init               build + status (one-shot setup)',
        '  register           register this server with a coding agent',
        '                     [--client claude|codex|gemini|all] (default claude)',
        '  onboard            guided setup + status',
        '  setup [capability] guided per-machine setup (read-only)',
        '  doctor             show delegation CLIs, servers, keys, and build status',
        '  handoff recall     print this project\'s HANDOFF.md',
        '  handoff write      save piped stdin as this project\'s HANDOFF.md',
        '  vault set <NAME>   store a secret in the macOS Keychain (hidden prompt)',
        '  vault rm  <NAME>   remove a secret',
        '  vault list         show which secrets are set (never the values)',
        '  config path        print the user config path (~/.vibecoders/config.json)',
        '  config get [key]   print the config (or one dotted key)',
        '  config set k v     set a non-secret option (features, memory, reference)',
        '  --version          print the version',
      ].join('\n');
      if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') {
        console.error(`Unknown command: ${cmd}`);
        console.error("Run 'vibecoders' with no arguments to see available commands.");
        process.exit(1);
      }
      console.log(help);
    }
  }
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

main().catch((e) => fail(e?.message ?? String(e)));

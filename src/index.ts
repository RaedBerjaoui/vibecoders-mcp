import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, SECRETS, type SecretKey } from './config/env';
import { loadServers, ToolIndex } from './gateway/registry';
import { Connector } from './gateway/connector';
import { registerGateway, connectEagerServers } from './gateway/lazyTools';
import { registerProviders } from './providers/tools';
import { availableProviders } from './providers/registry';
import { detectContext } from './capabilities/matrix';
import { CAPABILITIES } from './capabilities/registry';
import { resolveCapability } from './capabilities/types';
import { registerCapabilities } from './capabilities/tools';
import { createLogger } from './util/logger';
import { makeRedactor } from './util/redact';
import { text, errorText, setResponseRedactor } from './util/mcp';
import { computeLane } from './lanes/lane';
import { handoffPath } from './lanes/handoff';
import { registerLanes } from './lanes/tools';
import { z } from 'zod';
import { loadVibeConfig, featureEnabled, pinnedProvider, FEATURE_GROUPS } from './capabilities/config';
import { registerMemory } from './memory/tools';
import { loadNodes } from './memory/store';
import { registerProjectContext } from './context/project';
import { registerReference } from './reference/tools';
import { loadOverlay, overlayStatusLine, type OverlayResult } from './overlay/loader';
import { createTaskRegistry } from './tasks/registry';
import { registerTasks } from './tasks/tools';
import { registerDevice } from './device/tools';
import { registerVault } from './vault/tools';
import { registerRag } from './rag/tools';

// Injected from package.json at build time (build.mjs esbuild `define`). The dev runner
// (tsx, no define) leaves it undefined; `typeof` keeps that safe and falls back loudly.
declare const __VIBE_VERSION__: string | undefined;
const VERSION = typeof __VIBE_VERSION__ !== 'undefined' ? __VIBE_VERSION__ : '0.0.0-dev';

// ---- T28/T32/T33/T34: the shared, pure doctor renderer -------------------
// Both the MCP `doctor` tool and the CLI `status()` describe the SAME thing, so
// they must render identically. We capture status as a plain DATA object and
// render it with one pure function (no I/O — callers gather the data). The CLI
// is .mjs and keeps a faithful copy of this logic (see bin/vibecoders.mjs).

export interface DoctorCapability {
  label: string;
  ready: boolean;
  /** The configured provider's label, when ready. */
  provider?: string;
  /** Comma-joined option ids to set it up, when not ready. */
  options?: string;
}
export interface DoctorProvider {
  id: string;
  label: string;
  billing: string;
}
export interface DoctorKey {
  name: string;
  present: boolean;
}
export interface DoctorGroup {
  name: string;
  label: string;
  enabled: boolean;
}
/** Everything `doctor`/`status` can show. Optional fields are simply omitted. */
export interface DoctorData {
  capabilities: DoctorCapability[];
  providers: DoctorProvider[];
  servers: string[];
  keys: DoctorKey[];
  toolGroups: DoctorGroup[];
  lane?: { label: string; handoff: string };
  /** Pre-rendered one-line memory status (memoryLine), when memory is reportable. */
  memory?: string;
  /** Pre-rendered overlay status line, when known. */
  overlay?: string;
  /** CLI-only: whether dist/index.js is built. */
  build?: { present: boolean; path: string };
}

/**
 * T33 — "configured" means the user has done SOMETHING beyond defaults: a ready
 * capability, an installed delegation CLI, a mounted server, or a present key.
 * Tool-group defaults don't count (some are always on). Drives the all-empty
 * call-to-action and the JSON `configured` flag.
 */
function isAnythingConfigured(d: DoctorData): boolean {
  return (
    d.capabilities.some((c) => c.ready) ||
    d.providers.length > 0 ||
    d.servers.length > 0 ||
    d.keys.some((k) => k.present)
  );
}

const onOff = (b: boolean): string => (b ? '✓ on' : '· off');

/** Pure renderer: DoctorData → the human-readable doctor/status report. */
export function renderDoctor(d: DoctorData): string {
  const lines: string[] = ['Vibecoders — driver: Claude Code\n'];

  // T34 — legend up top: the two enablement systems are disjoint. Only shown
  // when both systems are actually reported (the pre-registration CLI omits them).
  if (d.capabilities.length > 0 || d.toolGroups.length > 0) {
    lines.push(
      'Legend: Capabilities (configure a provider) vs Tool groups (features.* toggle) — two separate systems.',
      '',
    );
  }

  if (d.capabilities.length > 0) {
    lines.push('Capabilities (✓ = a provider is configured for you; · = set one up):');
    for (const c of d.capabilities) {
      lines.push(
        c.ready
          ? `  ✓ ready — ${c.label} — via ${c.provider}`
          : `  · off — ${c.label} — set up one of: ${c.options ?? ''}`,
      );
    }
    lines.push('');
  }

  lines.push('Delegation providers (route work to your CLI subscription, not an API):');
  if (d.providers.length === 0) {
    lines.push('  (none — install codex, gemini, or claude to delegate on your subscription)');
  } else {
    for (const p of d.providers) lines.push(`  - ${p.id} (${p.label}) — bills via ${p.billing}`);
  }
  lines.push('');

  lines.push(
    `Mounted MCP servers (lazy — optional) — ${d.servers.length}: ${
      d.servers.join(', ') || '(none — copy servers.example.json → servers.json)'
    }`,
    '',
  );

  lines.push('API keys (optional — only for downstream servers/tools that need one):');
  for (const k of d.keys) lines.push(`  ${k.present ? '✓ set' : '· unset'} ${k.name}`);
  lines.push('');

  if (d.toolGroups.length > 0) {
    lines.push(
      'Tool groups (features.* toggle — independent of capabilities): ' +
        d.toolGroups.map((g) => `${onOff(g.enabled)} ${g.label}`).join('  '),
    );
    const off = d.toolGroups.filter((g) => !g.enabled).map((g) => g.name);
    if (off.length > 0) {
      lines.push(
        `  Disabled (${off.join(', ')}) → turn on with: vibecoders config set features.${off[0]} true  (then restart Claude Code)`,
      );
    }
  }

  if (d.build) {
    lines.push(
      d.build.present
        ? '\nBuild: ✓ dist/index.js present'
        : '\nBuild: · not built (run: vibecoders init)',
    );
  }
  if (d.lane) {
    lines.push(`\nLane: ${d.lane.label}`, `Handoff: ${d.lane.handoff}`);
  }
  if (d.memory) lines.push(d.memory);
  if (d.overlay) lines.push(d.overlay);

  // T33 — one prioritized next step when the machine is entirely unconfigured.
  if (!isAnythingConfigured(d)) {
    lines.push(
      '',
      'Next step: install a delegation CLI (codex / gemini / claude) — nothing else is required.',
    );
  }

  return lines.join('\n');
}

/** Structured, scriptable doctor output (T32 — `--json`). JSON-serializable. */
export function renderDoctorJson(d: DoctorData): {
  capabilities: DoctorCapability[];
  providers: DoctorProvider[];
  servers: string[];
  keys: DoctorKey[];
  toolGroups: DoctorGroup[];
  lane?: { label: string; handoff: string };
  configured: boolean;
} {
  return {
    capabilities: d.capabilities,
    providers: d.providers,
    servers: d.servers,
    keys: d.keys,
    toolGroups: d.toolGroups,
    ...(d.lane ? { lane: d.lane } : {}),
    configured: isAnythingConfigured(d),
  };
}

const INSTRUCTIONS = `Vibecoders is an MCP control plane, built to be driven from Claude Code.

Everything below is OPTIONAL — the server runs with no keys, no servers, and no
provider CLIs. Add only what you want.

• Design above Claude's defaults: building a UI, website, page, or component?
  Call design_core FIRST for the anti-AI-design RAG — the standard that makes the
  output not read as AI-made and hold its formatting, the tells principle, and the
  build non-negotiables — then design_layer to pull a deeper layer on demand
  (donts tells, formatting laws, directives, scaffolds, type pointers). Render
  imagery with generate_image.
• Swallow other MCP servers: rather than dumping every downstream tool into
  context, call search_tools → load_tool → call_tool to find and run any tool on
  a mounted server on demand. Hundreds of tools cost almost no context.
• Delegate to other coding agents on YOUR subscription (not a metered API): call
  list_providers, then delegate to hand a task to codex/gemini/claude via their
  CLI. Read-only by default; pass mode:"write" to allow file edits. Pass
  background:true to fire it without blocking and keep working; manage with
  tasks_list / tasks_steer / tasks_interrupt.
• Carry work across sessions: write_handoff / recall_handoff are isolated per
  working lane (cwd + git branch), so concurrent sessions never mix.
• Remember across sessions: memory_store / memory_recall / memory_walk are a
  per-user RAG knowledge graph (lexical by default; semantic if you enable
  embeddings with your own key). Store decisions/facts/gotchas and link them.
• Orient fast: project_context returns this repo's branch, recent commits,
  handoff, and the top memories for the project in one call.
• doctor reports exactly what is configured right now.`;

async function main(): Promise<void> {
  const config = await loadConfig();
  const log = createLogger(config.logLevel, config.secrets.values());
  // T10: guard the DATA PLANE too, not just stderr. Tool responses are returned
  // straight to the model (call_tool's downstream JSON, delegate's raw child
  // stdout, tasks/image/search child output). Install the redactor into the
  // text()/errorText() chokepoint from the SAME secret source the logger uses,
  // so a downstream echoing a token (or a CLI printing `env`) can't leak it into
  // the transcript. Scrubs known secret VALUES + the SECRET_PATTERNS in redact.ts.
  setResponseRedactor(makeRedactor([...config.secrets.values()]));

  const servers = loadServers();
  const index = new ToolIndex();
  const resolveEnv = (name: string): string | undefined =>
    config.secrets.get(name as SecretKey) ?? process.env[name];
  const connector = new Connector(servers, resolveEnv, log, config.timeoutMs);
  const lane = computeLane();
  const vibeConfig = loadVibeConfig();
  const memoryLine = (): string => {
    if (!featureEnabled(vibeConfig, 'memory')) return 'Memory: off (features.memory=false)';
    let count = 0;
    try {
      count = loadNodes().length;
    } catch {
      /* never let doctor fail on a missing/torn store */
    }
    const recall = vibeConfig.memory?.embeddings ? 'lexical+semantic' : 'lexical';
    const scope = vibeConfig.memory?.defaultScope ?? 'project';
    return `Memory: ${count} node${count === 1 ? '' : 's'} · recall=${recall} · default scope=${scope}`;
  };
  // Populated after native groups register (below); doctor reads it at call-time.
  let overlay: OverlayResult | undefined;

  // Gather live status as plain data, then render with the shared pure renderer
  // (renderDoctor/renderDoctorJson) so the MCP doctor and the CLI status agree.
  const buildDoctorData = (): DoctorData => {
    const ctx = detectContext((k) => config.has(k as SecretKey));
    return {
      capabilities: CAPABILITIES.map((cap) => {
        const res = resolveCapability(cap, ctx, pinnedProvider(vibeConfig, cap.id));
        return res.status === 'ready'
          ? { label: cap.label, ready: true, provider: res.provider.label }
          : { label: cap.label, ready: false, options: cap.providers.map((p) => p.id).join(', ') };
      }),
      providers: availableProviders().map((a) => ({
        id: a.def.id,
        label: a.def.label,
        billing: a.def.billing,
      })),
      servers: Object.keys(servers),
      keys: SECRETS.map((k) => ({ name: k, present: config.has(k) })),
      toolGroups: FEATURE_GROUPS.map((g) => ({
        name: g.name,
        label: g.label,
        enabled: featureEnabled(vibeConfig, g.name),
      })),
      lane: { label: lane.label, handoff: handoffPath(lane) },
      memory: memoryLine(),
      overlay: overlay ? overlayStatusLine(overlay) : 'Private overlay: load error (see server logs)',
    };
  };

  const server = new McpServer(
    { name: 'vibecoders', version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  // Native, secret-free status tool. Everything it reports is optional. Pass
  // json:true for the structured, scriptable variant (T32).
  server.registerTool(
    'doctor',
    {
      description:
        'Report Vibecoders status: capabilities, delegation providers, mounted servers, optional API keys, tool groups, and this session’s lane. Pass json:true for structured output. Never prints secret values.',
      inputSchema: { json: z.boolean().optional() },
    },
    async ({ json }) => {
      const data = buildDoctorData();
      return json
        ? text(JSON.stringify(renderDoctorJson(data), null, 2))
        : text(renderDoctor(data));
    },
  );

  const tasksEnabled = featureEnabled(vibeConfig, 'tasks');
  const taskRegistry = tasksEnabled ? createTaskRegistry() : undefined;
  registerProviders(server, { log, tasks: taskRegistry });
  registerCapabilities(server, resolveEnv, log);
  registerGateway(server, servers, connector, index, log);
  registerLanes(server, lane);
  if (featureEnabled(vibeConfig, 'memory')) {
    registerMemory(server, { lane, getSecret: resolveEnv, memory: vibeConfig.memory ?? {}, log });
  }
  if (featureEnabled(vibeConfig, 'projectContext')) {
    registerProjectContext(server, () => ({ lane, vibeConfig }));
  }
  if (featureEnabled(vibeConfig, 'reference')) {
    registerReference(server, { config: vibeConfig.reference ?? {}, timeoutMs: config.timeoutMs, log });
  }
  if (tasksEnabled) {
    registerTasks(server, { tasks: taskRegistry!, log });
  }
  if (featureEnabled(vibeConfig, 'device')) {
    registerDevice(server, { log });
  }
  if (featureEnabled(vibeConfig, 'vault')) {
    registerVault(server, { config: vibeConfig.vault ?? {}, log });
  }
  if (featureEnabled(vibeConfig, 'rag')) {
    registerRag(server, { log });
  }

  // Private overlay: owner-local BYO capability modules (never shipped). Generic,
  // fail-closed, loaded last so it can build on native groups. See docs/private-overlay.md.
  try {
    overlay = await loadOverlay(server, { log, config: vibeConfig, lane, text, errorText });
    log.info(overlayStatusLine(overlay));
  } catch (e) {
    log.warn(`[overlay] load failed: ${(e as Error).message}`);
  }

  // Warm + index servers declared `lazy:false` so their tools are searchable the
  // moment we're live (lazy:true servers stay cold until first use). Fail-soft and
  // concurrency-bounded internally — one slow/broken eager server can't block boot.
  try {
    await connectEagerServers(servers, connector, index, log);
  } catch (e) {
    log.warn(`[gateway] eager connect failed: ${(e as Error).message}`);
  }

  await server.connect(new StdioServerTransport());
  log.info(`vibecoders mcp ready · lane ${lane.label}`);

  const shutdown = async (): Promise<void> => {
    await connector.closeAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Boot the server only when run as the entrypoint — NOT when imported (e.g. the
// doctor-renderer unit tests import this module for renderDoctor/renderDoctorJson
// and must not spawn a transport or install signal handlers). We compare REAL
// paths: `import.meta.url` is already realpath-resolved, but process.argv[1] may
// carry a symlinked path (e.g. /tmp → /private/tmp on macOS), so naively URL-
// comparing the two would wrongly conclude "not main" for the bundled artifact.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const self = fileURLToPath(import.meta.url);
    return realpathSync(self) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err: unknown) => {
    process.stderr.write(`[vibecoders] FATAL ${(err as Error).message}\n`);
    process.exit(1);
  });
}

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  InitializeRequestSchema,
  type InitializeRequest,
  type InitializeResult,
} from '@modelcontextprotocol/sdk/types.js';
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
import { resolveHost } from './host/profile';
import { instructionsFor, type InstructionsCtx } from './host/instructions';
import { applyHostAdaptations } from './host/adapt';
import { registerSkills } from './skills/tools';

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
  /** The driving MCP client, label + how we know it (e.g. "OpenAI Codex (detected)"). */
  driver?: string;
  /** How to make THIS host re-read the tool list after a config change. */
  restartHint?: string;
  /** Structured host identity for the JSON output. */
  hostInfo?: { id: string; label: string; source: string };
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
  const lines: string[] = [`Vibecoders — driver: ${d.driver ?? 'not connected'}\n`];

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
        `  Disabled (${off.join(', ')}) → turn on with: vibecoders config set features.${off[0]} true  (then ${d.restartHint ?? 'restart your MCP client'})`,
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
  host?: { id: string; label: string; source: string };
  configured: boolean;
} {
  return {
    capabilities: d.capabilities,
    providers: d.providers,
    servers: d.servers,
    keys: d.keys,
    toolGroups: d.toolGroups,
    ...(d.lane ? { lane: d.lane } : {}),
    ...(d.hostInfo ? { host: d.hostInfo } : {}),
    configured: isAnythingConfigured(d),
  };
}

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

  // Which MCP client is driving us. Boot-time is a best guess (config force / env
  // pin are already authoritative here); the initialize handler below refines it
  // from clientInfo. `let` because that handler reassigns it, and everything that
  // reads `host` (doctor, delegate's restart hint, instructions) does so lazily.
  let host = resolveHost({
    force: vibeConfig.host?.force,
    adaptive: vibeConfig.host?.adaptive,
    env: process.env,
  });

  // The provider ids backing the two adaptable capabilities THIS session, resolved
  // exactly like buildDoctorData (detectContext + pin + priority order). Host
  // adaptation compares the .id (not the label) against known native engines.
  const capabilityProviderIds = (): { imageProviderId?: string; searchProviderId?: string } => {
    const ctx = detectContext((k) => config.has(k as SecretKey));
    const resolveId = (capabilityId: string): string | undefined => {
      const cap = CAPABILITIES.find((c) => c.id === capabilityId);
      if (!cap) return undefined;
      const res = resolveCapability(cap, ctx, pinnedProvider(vibeConfig, cap.id));
      return res.status === 'ready' ? res.provider.id : undefined;
    };
    return { imageProviderId: resolveId('image_gen'), searchProviderId: resolveId('web_search') };
  };

  // Runtime facts the instructions builder needs beyond the static host profile.
  // imageRedundant/searchRedundant mirror the exact conditions under which
  // applyHostAdaptations HIDES generate_image / web_search, so the prose and the
  // tool list never disagree.
  const instructionsCtx = (): InstructionsCtx => {
    const { imageProviderId, searchProviderId } = capabilityProviderIds();
    return {
      imageRedundant:
        host.profile.native.imageGen &&
        imageProviderId !== undefined &&
        ['codex-cli', 'openai-api'].includes(imageProviderId),
      searchRedundant:
        host.profile.id === 'gemini-cli' &&
        searchProviderId !== undefined &&
        ['gemini-cli', 'gemini-api'].includes(searchProviderId),
      skillsEnabled: featureEnabled(vibeConfig, 'skills'),
      memoryEnabled: featureEnabled(vibeConfig, 'memory'),
      ragEnabled: featureEnabled(vibeConfig, 'rag'),
      tasksEnabled: featureEnabled(vibeConfig, 'tasks'),
    };
  };

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
      // How we know the driver: clientInfo = detected from the handshake; env/config
      // = the operator pinned it; default = nobody's connected / unrecognized.
      driver:
        host.profile.label +
        (host.source === 'clientInfo'
          ? ' (detected)'
          : host.source === 'env' || host.source === 'config'
            ? ' (pinned)'
            : ''),
      restartHint: host.profile.restartHint,
      hostInfo: { id: host.profile.id, label: host.profile.label, source: host.source },
    };
  };

  const server = new McpServer(
    { name: 'vibecoders', version: VERSION },
    { instructions: instructionsFor(host.profile, instructionsCtx()) },
  );

  // Tool handles gathered from each register* call, so the initialize handler can
  // adapt visibility/descriptions to the driving client before its first
  // tools/list. Undefined entries (feature off) are skipped by the adapter.
  const toolHandles: Record<string, RegisteredTool | undefined> = {};

  // Native, secret-free status tool. Everything it reports is optional. Pass
  // json:true for the structured, scriptable variant (T32).
  const doctorTool = server.registerTool(
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
  toolHandles.doctor = doctorTool;

  const tasksEnabled = featureEnabled(vibeConfig, 'tasks');
  const taskRegistry = tasksEnabled ? createTaskRegistry() : undefined;
  Object.assign(
    toolHandles,
    registerProviders(server, { log, tasks: taskRegistry, getHost: () => host.profile }),
  );
  Object.assign(toolHandles, registerCapabilities(server, resolveEnv, log));
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
    Object.assign(toolHandles, registerDevice(server, { log }));
  }
  if (featureEnabled(vibeConfig, 'vault')) {
    registerVault(server, { config: vibeConfig.vault ?? {}, log });
  }
  if (featureEnabled(vibeConfig, 'rag')) {
    registerRag(server, { log });
  }
  if (featureEnabled(vibeConfig, 'skills')) {
    Object.assign(toolHandles, registerSkills(server, { getHost: () => host.profile, log }));
  }

  // Per-client adaptation, applied inside the initialize handshake. We DELEGATE to
  // the SDK's own _oninitialize (bound before we override) so protocol negotiation
  // AND clientInfo storage (getClientVersion) still happen; then we refine `host`
  // from the just-received clientInfo, adapt the registered tools + the instructions
  // string, and return the SDK's result with our per-host instructions. Everything
  // is synchronous: Codex caches the tool list per session and ignores
  // tools/list_changed, so visibility must be settled before this returns.
  const rawServer = server.server as unknown as {
    _oninitialize?: (req: InitializeRequest) => Promise<InitializeResult>;
  };
  if (typeof rawServer._oninitialize === 'function') {
    const inner = rawServer._oninitialize.bind(server.server);
    server.server.setRequestHandler(InitializeRequestSchema, async (request) => {
      const result = await inner(request);
      host = resolveHost(
        { force: vibeConfig.host?.force, adaptive: vibeConfig.host?.adaptive, env: process.env },
        request.params.clientInfo,
      );
      for (const change of applyHostAdaptations(host.profile, toolHandles, capabilityProviderIds())) {
        log.info(`[host] ${change}`);
      }
      log.info(
        `[host] driving client: ${host.profile.label} (${host.source}${host.clientName ? `: ${host.clientName}` : ''})`,
      );
      return { ...result, instructions: instructionsFor(host.profile, instructionsCtx()) };
    });
  } else {
    log.warn('[host] SDK _oninitialize not found — static instructions, degraded adaptivity');
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

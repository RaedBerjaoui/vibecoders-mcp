/**
 * Which MCP client is driving us, so instruction text and tool visibility can
 * adapt to the surface. Detection is coarse UX branching ONLY — clientInfo comes
 * from an unauthenticated handshake and its `name` varies across surfaces and
 * carries suffixes (Anthropic's own guidance: match a PATTERN, never an exact
 * string, and never use clientInfo for anything security-relevant). Precedence,
 * most to least trusted: config force > env override > clientInfo handshake.
 */
export type HostId = 'claude-code' | 'codex' | 'gemini-cli' | 'unknown';
export type HostSource = 'config' | 'env' | 'clientInfo' | 'default';

export interface HostProfile {
  id: HostId;
  label: string;
  /** How to make the host re-read the tool list after a config change. */
  restartHint: string;
  /** Delegation provider id that would spawn a second instance of this same host. */
  selfProviderId?: 'claude' | 'codex' | 'gemini';
  /** What the host already has natively, so we can hide/reframe duplicates. */
  native: { imageGen: boolean; liveWebSearch: boolean; subagents: boolean; skills: boolean };
}

export const PROFILES: Record<HostId, HostProfile> = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    restartHint: 'restart Claude Code',
    selfProviderId: 'claude',
    // Ships live web search, subagents, and skills; image generation is the one
    // design capability it genuinely lacks, so that stays worth surfacing.
    native: { imageGen: false, liveWebSearch: true, subagents: true, skills: true },
  },
  codex: {
    id: 'codex',
    label: 'OpenAI Codex',
    // Codex caches the MCP tool list per session and ignores tools/list_changed,
    // so a config change is invisible until a brand-NEW session, not a reload.
    restartHint: 'start a new Codex session (Codex caches the tool list per session)',
    selfProviderId: 'codex',
    // imagegen is on by default and it has a multi-agent suite + skills; its web
    // search defaults to a CACHED index, not the live web — hence liveWebSearch:false.
    native: { imageGen: true, liveWebSearch: false, subagents: true, skills: true },
  },
  'gemini-cli': {
    id: 'gemini-cli',
    label: 'Google Gemini CLI',
    restartHint: 'restart Gemini CLI',
    selfProviderId: 'gemini',
    // Has live google_web_search, but no subagent suite and no skills system.
    native: { imageGen: false, liveWebSearch: true, subagents: false, skills: false },
  },
  unknown: {
    id: 'unknown',
    label: 'this MCP client',
    restartHint: 'restart your MCP client',
    // Assume nothing about an unrecognized host — surface every capability.
    native: { imageGen: false, liveWebSearch: false, subagents: false, skills: false },
  },
};

/**
 * Coarse, case-insensitive family match on a client name. Tests a substring
 * pattern rather than equality because the same host reports differently spelled
 * names across surfaces; `undefined` means "not a family we specialize for".
 */
export function matchHostId(clientName: string): HostId | undefined {
  const n = clientName.toLowerCase();
  if (/claude|anthropic/.test(n)) return 'claude-code';
  if (/codex/.test(n)) return 'codex';
  if (/gemini/.test(n)) return 'gemini-cli';
  return undefined;
}

export interface HostResolution {
  profile: HostProfile;
  source: HostSource;
  /** The raw handshake name, echoed only when detection came from clientInfo. */
  clientName?: string;
}

export function resolveHost(
  opts: { force?: string; adaptive?: boolean; env?: NodeJS.ProcessEnv },
  clientInfo?: { name: string; version?: string },
): HostResolution {
  // Operator opt-out: treat every host as generic, whatever the handshake says.
  if (opts.adaptive === false) {
    return { profile: PROFILES.unknown, source: 'config' };
  }
  // Explicit force pins the host; an unrecognized value pins to unknown, but the
  // source is still 'config' — the operator's choice, not a fallback.
  if (opts.force) {
    return { profile: PROFILES[matchHostId(opts.force) ?? 'unknown'], source: 'config' };
  }
  const env: NodeJS.ProcessEnv = opts.env ?? {};
  const envName = env.VIBECODERS_CLIENT;
  if (envName) {
    return { profile: PROFILES[matchHostId(envName) ?? 'unknown'], source: 'env' };
  }
  // Lowest-trust signal: the unauthenticated initialize handshake. A recognized
  // name is a real detection ('clientInfo'); an unrecognized one is no better
  // than having nothing ('default'), though we still echo what was reported.
  if (clientInfo?.name) {
    const matched = matchHostId(clientInfo.name);
    return matched
      ? { profile: PROFILES[matched], source: 'clientInfo', clientName: clientInfo.name }
      : { profile: PROFILES.unknown, source: 'default', clientName: clientInfo.name };
  }
  return { profile: PROFILES.unknown, source: 'default' };
}

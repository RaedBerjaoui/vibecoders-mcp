/**
 * Delegation providers — let Claude Code hand work to another coding agent's
 * **CLI**, so usage bills through your existing subscription instead of a
 * metered API key. Everything here is optional: if a CLI isn't installed, its
 * provider simply isn't offered. No keys, no config required to run.
 *
 * Read-only by default — a delegated agent can read and reason, but only writes
 * to your files when you explicitly ask for `mode: "write"`.
 *
 * Invocations use battle-tested headless flags: the prompt arrives over stdin,
 * flags are chosen so the CLI can't hang waiting for a prompt, and API-key env
 * is stripped so each CLI authenticates via its own subscription/OAuth.
 */
import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';

export type DelegateMode = 'read' | 'write';

export interface BuildArgs {
  prompt: string;
  mode: DelegateMode;
  model?: string;
  cwd?: string;
  /** Temp file a provider may write its final message to (see readsOutputFromFile). */
  outFile?: string;
}

export interface ProviderDef {
  /** Stable id used by the `delegate` tool. */
  id: string;
  /** Human label. */
  label: string;
  /** CLI binary to invoke (overridable via env). */
  command: string;
  /** One line on how this provider bills — emphasises the subscription route. */
  billing: string;
  /** How the prompt reaches the CLI. */
  promptVia: 'stdin' | 'argv';
  /** When true, the clean final answer is read from `outFile`, not stdout. */
  readsOutputFromFile?: boolean;
  /** Build argv (excluding the prompt when promptVia === 'stdin'). */
  args: (a: BuildArgs) => string[];
  /** Child-env adjustments: force subscription/OAuth auth, strip API keys. */
  env?: { unset?: string[]; set?: Record<string, string> };
  /** Optional: pull the clean answer out of raw stdout (e.g. parse JSON). */
  parseStdout?: (stdout: string) => string;
}

/** Resolve a command to an absolute path on PATH, cross-platform. */
export function resolveOnPath(command: string): string | undefined {
  if (command.includes('/') || command.includes('\\')) {
    return existsSync(command) ? command : undefined;
  }
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
      : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = join(dir, command + ext);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

const env = (name: string, fallback: string): string => process.env[name] || fallback;

/**
 * Auth env to strip from any codex invocation so it bills the ChatGPT/Codex plan
 * (OAuth via ~/.codex/auth.json), not the metered OpenAI API. Shared by the codex
 * delegate provider below AND the image_gen codex executor (capabilities/image.ts)
 * so the two can never drift — add a third var here and both honor it.
 */
export const CODEX_AUTH_ENV_UNSET = ['OPENAI_API_KEY', 'OPENAI_AUTH_TOKEN'] as const;

/** Pull the first balanced JSON object out of a noisy stdout blob. */
function firstJsonObject(s: string): unknown {
  const start = s.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) {
      return JSON.parse(s.slice(start, i + 1));
    }
  }
  return undefined;
}

export const BUILTIN_PROVIDERS: ProviderDef[] = [
  {
    id: 'codex',
    label: 'OpenAI Codex',
    command: env('VIBECODERS_CODEX_CMD', 'codex'),
    billing: 'your ChatGPT/Codex CLI plan, not the OpenAI API',
    promptVia: 'stdin',
    readsOutputFromFile: true,
    args: ({ mode, model, cwd, outFile }) => [
      'exec',
      '--skip-git-repo-check', // scaffolded/non-repo dirs must not block
      '--ephemeral', // don't persist a session; faster cold start
      '--ignore-user-config', // skip ~/.codex MCP-OAuth spam that hangs startup
      '--sandbox',
      mode === 'write' ? 'workspace-write' : 'read-only',
      ...(cwd ? ['-C', cwd] : []),
      ...(outFile ? ['--output-last-message', outFile] : []),
      ...(model ? ['-m', model] : []),
    ],
    // Strip API creds so Codex uses ~/.codex/auth.json (your ChatGPT plan).
    env: { unset: [...CODEX_AUTH_ENV_UNSET] },
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    command: env('VIBECODERS_GEMINI_CMD', 'gemini'),
    billing: 'your Gemini CLI plan, not the Gemini API',
    promptVia: 'stdin',
    args: ({ mode, model }) => [
      '-p',
      '', // placeholder; the real prompt arrives on stdin
      '-o',
      'json', // structured output we can parse cleanly
      '--approval-mode',
      mode === 'write' ? 'auto_edit' : 'plan',
      '--skip-trust', // headless: don't block on the workspace-trust prompt
      ...(model ? ['-m', model] : []),
    ],
    // Force Gemini Code Assist OAuth (your plan), not the API key.
    env: {
      unset: ['GEMINI_API_KEY'],
      set: { GOOGLE_GENAI_USE_GCA: 'true', GEMINI_CLI_TRUST_WORKSPACE: 'true' },
    },
    parseStdout: (s) => {
      const j = firstJsonObject(s) as { response?: string } | undefined;
      return (j?.response ?? s).trim();
    },
  },
  {
    id: 'claude',
    label: 'Claude Code',
    command: env('VIBECODERS_CLAUDE_CMD', 'claude'),
    billing: 'your Claude plan, not the Anthropic API',
    promptVia: 'argv',
    args: ({ prompt, mode, model }) => [
      '-p',
      prompt,
      '--output-format',
      'text',
      '--permission-mode',
      mode === 'write' ? 'acceptEdits' : 'plan',
      ...(model ? ['--model', model] : []),
    ],
    env: { unset: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] },
  },
];

export function getProvider(id: string, providers = BUILTIN_PROVIDERS): ProviderDef | undefined {
  return providers.find((p) => p.id === id);
}

export interface AvailableProvider {
  def: ProviderDef;
  /** Absolute path to the resolved CLI. */
  path: string;
}

/** The subset of providers whose CLI is actually installed on this machine. */
export function availableProviders(providers = BUILTIN_PROVIDERS): AvailableProvider[] {
  const out: AvailableProvider[] = [];
  for (const def of providers) {
    const path = resolveOnPath(def.command);
    if (path) out.push({ def, path });
  }
  return out;
}

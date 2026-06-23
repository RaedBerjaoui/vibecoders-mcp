/**
 * Build the environment handed to a spawned child (a delegation CLI, the codex
 * image_gen executor, the gemini search CLI).
 *
 * WHY THIS EXISTS — the #1 security gap it closes: vibecoders is a control plane
 * that spawns external CLIs and returns their stdout/stderr verbatim in tool
 * responses. If a child inherits the FULL `process.env`, an UNRELATED secret in
 * the operator's environment (a Stripe key, another project's token) is handed
 * to every CLI and can leak straight into the transcript. The default `minimal`
 * mode forwards only a generous allowlist of non-secret operational vars plus
 * whatever a specific provider legitimately needs, so unrelated secrets never
 * leave this process.
 *
 *   - mode 'minimal' (default): result = (BASE_ENV_ALLOWLIST ∪ allow), copying
 *     only the keys actually set in the source, MINUS everything in `unset`.
 *   - mode 'inherit': result = a copy of the whole source, MINUS `unset`. This
 *     preserves the legacy behavior for operators who opt back in, while still
 *     honoring per-provider strips (e.g. codex's OAuth-billing key removal).
 *
 * Pure & synchronous: it never mutates the source and returns a fresh object.
 */

export type ChildEnvMode = 'minimal' | 'inherit';

export interface BuildChildEnvOptions {
  mode: ChildEnvMode;
  /** Extra vars THIS provider legitimately needs forwarded (minimal mode). */
  allow?: readonly string[];
  /** Vars to strip in BOTH modes (e.g. API creds, to force subscription auth). */
  unset?: readonly string[];
  /** Injectable env source for testing; defaults to the real process.env. */
  source?: NodeJS.ProcessEnv;
}

/**
 * Generous allowlist of NON-SECRET operational vars forwarded in minimal mode.
 *
 * HOME + PATH are load-bearing: the coding-agent CLIs (codex/gemini/claude)
 * authenticate via files under $HOME (e.g. ~/.codex/auth.json) and find their
 * binary/helpers via PATH — drop these and the CLIs break. The rest are locale,
 * shell, temp-dir, and XDG config/cache locations that real CLIs read but which
 * carry no credentials. Windows equivalents are included best-effort. The
 * dynamic `LC_*` family is folded in at build time (see below).
 */
export const BASE_ENV_ALLOWLIST: readonly string[] = [
  // Essential: binary/helper resolution + the home dir CLIs auth from.
  'PATH',
  'HOME',
  // Identity / shell (some CLIs derive config dirs or git author from these).
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'TERM',
  // Temp dirs (CLIs write scratch state here).
  'TMPDIR',
  'TEMP',
  'TMP',
  // Locale (avoids mojibake / encoding fallbacks in CLI output).
  'LANG',
  'LANGUAGE',
  // XDG base dirs (where modern CLIs keep config/cache/data/runtime state).
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  // Node runtime flags (a Node-based CLI may rely on these; non-secret).
  'NODE_OPTIONS',
  // Windows equivalents (best-effort cross-platform support).
  'SystemRoot',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
];

export function buildChildEnv(opts: BuildChildEnvOptions): NodeJS.ProcessEnv {
  const source = opts.source ?? process.env;
  const unset = new Set(opts.unset ?? []);

  let result: NodeJS.ProcessEnv;

  if (opts.mode === 'inherit') {
    // Full inheritance (legacy behavior), minus the per-provider strip list.
    result = { ...source };
  } else {
    // minimal: copy ONLY the allowlisted keys that are actually set in source.
    result = {};
    // The LC_* locale family is dynamic (LC_ALL, LC_CTYPE, LC_MESSAGES, …) — fold
    // in whatever is present so locale-sensitive CLI output stays correct.
    const dynamicLc = Object.keys(source).filter((k) => k.startsWith('LC_'));
    const allowed = new Set<string>([...BASE_ENV_ALLOWLIST, ...dynamicLc, ...(opts.allow ?? [])]);
    for (const key of allowed) {
      const val = source[key];
      if (val !== undefined) result[key] = val;
    }
  }

  for (const key of unset) delete result[key];
  return result;
}

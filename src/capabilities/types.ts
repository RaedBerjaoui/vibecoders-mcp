/**
 * Capability × Provider model — the heart of the "customizable server".
 *
 * A **capability** is a user-facing feature (image generation, web search, a
 * memory graph, …) exposed as one or more MCP tools. Each capability lists
 * several **provider options**; configuring ANY ONE of them enables the whole
 * capability. A **provider** is a concrete fulfilment — a local CLI or a
 * bring-your-own API key — and knows, via its `requires`, what makes it usable.
 *
 * Nothing here is tied to a person: the repo ships only generic capability and
 * provider definitions. Each user wires their own CLIs/keys locally, AFTER
 * install. An unconfigured capability fails CLOSED — it returns an actionable
 * "set up one of: …" hint instead of erroring vaguely or doing nothing.
 */

/** What a provider needs before it counts as configured on this machine. */
export type Requirement =
  | { kind: 'cli'; command: string } // a binary resolvable on PATH
  | { kind: 'secret'; key: string }; // a secret/env key that is present

export interface CapabilityProvider {
  /** Stable id, unique within its capability (e.g. 'codex-cli', 'openai-api'). */
  id: string;
  label: string;
  /** Configured only when EVERY requirement is satisfied (usually just one). */
  requires: Requirement[];
  /** One actionable line telling the user how to turn this option on. */
  setupHint: string;
}

/**
 * T30 — the OS-aware way to tell a user how to provide a secret. `vibecoders
 * vault set <NAME>` writes the **macOS Keychain ONLY** (see config/env.ts, which
 * branches on `process.platform === 'darwin'`); on Linux/Windows that command
 * stores nothing, so prescribing it there sends the user down a dead end. We
 * mirror env.ts's platform check and make `.env` the cross-platform path.
 *
 * Pure: `isMacOS` is passed in (defaulting to the real platform) so both
 * branches are unit-testable WITHOUT depending on the host OS.
 */
export function secretSetupHint(
  key: string,
  isMacOS: boolean = process.platform === 'darwin',
): string {
  return isMacOS
    ? `set ${key} — run \`vibecoders vault set ${key}\` (macOS Keychain) or add \`${key}=...\` to your .env`
    : `set ${key} — add \`${key}=...\` to your .env`;
}

export interface CapabilityDef {
  /** Stable id; doubles as the key under `capabilities` in the user config. */
  id: string;
  label: string;
  summary: string;
  /** Ordered options; the first configured one wins unless the user pins one. */
  providers: CapabilityProvider[];
}

/**
 * Environment probe. Keeping detection behind an interface lets `resolve` stay
 * pure and unit-testable without touching PATH, the Keychain, or env.
 */
export interface DetectContext {
  hasCli(command: string): boolean;
  hasSecret(key: string): boolean;
}

/** True when all of a provider's requirements are met. */
export function isProviderConfigured(p: CapabilityProvider, ctx: DetectContext): boolean {
  return p.requires.every((r) =>
    r.kind === 'cli' ? ctx.hasCli(r.command) : ctx.hasSecret(r.key),
  );
}

export type Resolution =
  | { status: 'ready'; provider: CapabilityProvider }
  | { status: 'unconfigured'; options: CapabilityProvider[] };

/**
 * Pick the provider for a capability:
 *   1. the user's pinned choice, if set AND currently configured;
 *   2. otherwise the first configured option, in declared (priority) order;
 *   3. otherwise `unconfigured` with every option, so the caller can list hints.
 */
export function resolveCapability(
  cap: CapabilityDef,
  ctx: DetectContext,
  pinnedProviderId?: string,
): Resolution {
  if (pinnedProviderId) {
    const pinned = cap.providers.find((p) => p.id === pinnedProviderId);
    if (pinned && isProviderConfigured(pinned, ctx)) {
      return { status: 'ready', provider: pinned };
    }
  }
  const first = cap.providers.find((p) => isProviderConfigured(p, ctx));
  if (first) return { status: 'ready', provider: first };
  return { status: 'unconfigured', options: cap.providers };
}

/** The fail-closed message shown when a capability has no configured provider. */
export function unconfiguredMessage(cap: CapabilityDef): string {
  const opts = cap.providers.map((p) => `  • ${p.label} — ${p.setupHint}`).join('\n');
  return `${cap.label} is not set up yet. To enable it, configure one of:\n${opts}`;
}

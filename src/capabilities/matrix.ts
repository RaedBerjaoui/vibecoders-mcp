/**
 * Renders the capability matrix that `doctor` shows: one line per capability,
 * ✓ when a provider is configured (naming which one), · when it is not (listing
 * the options that would turn it on). This is the at-a-glance answer to "what
 * can this server actually do for ME right now".
 */
import { resolveOnPath } from '../providers/registry';
import { CAPABILITIES } from './registry';
import { resolveCapability, type CapabilityDef, type DetectContext } from './types';
import { loadVibeConfig, pinnedProvider, type VibeConfig } from './config';

/**
 * Build a DetectContext from the real machine: CLIs are probed on PATH (cached),
 * secrets are answered by the caller's resolver (Keychain/env via loadConfig).
 */
export function detectContext(hasSecret: (key: string) => boolean): DetectContext {
  const cliCache = new Map<string, boolean>();
  return {
    hasCli(command) {
      let hit = cliCache.get(command);
      if (hit === undefined) {
        hit = Boolean(resolveOnPath(command));
        cliCache.set(command, hit);
      }
      return hit;
    },
    hasSecret,
  };
}

export function capabilityMatrix(
  hasSecret: (key: string) => boolean,
  cfg: VibeConfig = loadVibeConfig(),
  caps: CapabilityDef[] = CAPABILITIES,
): string {
  if (caps.length === 0) return '  (none yet)';
  const ctx = detectContext(hasSecret);
  return caps
    .map((cap) => {
      const res = resolveCapability(cap, ctx, pinnedProvider(cfg, cap.id));
      if (res.status === 'ready') {
        return `  ✓ ${cap.label} — via ${res.provider.label}`;
      }
      const options = cap.providers.map((p) => p.id).join(', ');
      return `  · ${cap.label} — set up one of: ${options}`;
    })
    .join('\n');
}

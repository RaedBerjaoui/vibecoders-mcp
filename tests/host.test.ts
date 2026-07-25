import { describe, it, expect } from 'vitest';
import { resolveHost, matchHostId, PROFILES, type HostId } from '../src/host/profile';
import { instructionsFor, type InstructionsCtx } from '../src/host/instructions';

describe('matchHostId (coarse, case-insensitive family match)', () => {
  it('matches the Codex client name regardless of case', () => {
    expect(matchHostId('CODEX-mcp-CLIENT')).toBe('codex');
    expect(matchHostId('codex-mcp-client')).toBe('codex');
  });

  it('maps every Claude surface name to claude-code', () => {
    // Claude sends a SET of names depending on surface; all fold to one host.
    expect(matchHostId('claude-code')).toBe('claude-code');
    expect(matchHostId('claude-ai')).toBe('claude-code');
    expect(matchHostId('Anthropic Claude')).toBe('claude-code');
    expect(matchHostId('Anthropic')).toBe('claude-code');
  });

  it('matches the Gemini CLI client name', () => {
    expect(matchHostId('gemini-cli-mcp-client')).toBe('gemini-cli');
  });

  it('returns undefined for an unrecognized client', () => {
    expect(matchHostId('weird-editor')).toBeUndefined();
  });
});

describe('PROFILES', () => {
  it('gives every host a non-empty label and restartHint', () => {
    for (const id of Object.keys(PROFILES) as HostId[]) {
      expect(PROFILES[id].label.length).toBeGreaterThan(0);
      expect(PROFILES[id].restartHint.length).toBeGreaterThan(0);
    }
  });

  it('records that Codex has native image generation and Claude Code does not', () => {
    expect(PROFILES.codex.native.imageGen).toBe(true);
    expect(PROFILES['claude-code'].native.imageGen).toBe(false);
  });

  it('names the self-delegation provider for Codex', () => {
    expect(PROFILES.codex.selfProviderId).toBe('codex');
  });

  it('labels the unknown host generically and claims no native capabilities', () => {
    expect(PROFILES.unknown.label).toBe('this MCP client');
    expect(PROFILES.unknown.selfProviderId).toBeUndefined();
    expect(PROFILES.unknown.native).toEqual({
      imageGen: false,
      liveWebSearch: false,
      subagents: false,
      skills: false,
    });
  });
});

describe('resolveHost precedence (config force > env > clientInfo > default)', () => {
  it('detects Codex from the initialize handshake', () => {
    const r = resolveHost({}, { name: 'codex-mcp-client', version: '1' });
    expect(r.profile.id).toBe('codex');
    expect(r.source).toBe('clientInfo');
    expect(r.clientName).toBe('codex-mcp-client');
  });

  it('detects Claude Code from any of its surface names', () => {
    for (const name of ['claude-code', 'claude-ai', 'Anthropic Claude']) {
      const r = resolveHost({}, { name });
      expect(r.profile.id).toBe('claude-code');
      expect(r.source).toBe('clientInfo');
    }
  });

  it('detects Gemini CLI from the handshake', () => {
    const r = resolveHost({}, { name: 'gemini-cli-mcp-client' });
    expect(r.profile.id).toBe('gemini-cli');
    expect(r.source).toBe('clientInfo');
  });

  it('falls back to unknown/default for an unrecognized client name, still echoing it', () => {
    const r = resolveHost({}, { name: 'weird-editor' });
    expect(r.profile.id).toBe('unknown');
    expect(r.source).toBe('default');
    expect(r.clientName).toBe('weird-editor');
  });

  it('lets VIBECODERS_CLIENT override a conflicting handshake', () => {
    const r = resolveHost(
      { env: { VIBECODERS_CLIENT: 'codex' } },
      { name: 'claude-code' },
    );
    expect(r.profile.id).toBe('codex');
    expect(r.source).toBe('env');
    // The env override is not a handshake, so it does not echo a clientName.
    expect(r.clientName).toBeUndefined();
  });

  it('lets config force outrank both env and the handshake', () => {
    const r = resolveHost(
      { force: 'gemini', env: { VIBECODERS_CLIENT: 'codex' } },
      { name: 'codex-mcp-client' },
    );
    expect(r.profile.id).toBe('gemini-cli');
    expect(r.source).toBe('config');
  });

  it('treats adaptive:false as an explicit opt-out to the generic profile', () => {
    const r = resolveHost({ adaptive: false }, { name: 'codex-mcp-client' });
    expect(r.profile.id).toBe('unknown');
    expect(r.source).toBe('config');
  });

  it('returns unknown/default when there is no env and no handshake', () => {
    const r = resolveHost({});
    expect(r.profile.id).toBe('unknown');
    expect(r.source).toBe('default');
  });
});

describe('instructionsFor (per-host server instructions builder)', () => {
  // Everything on, nothing redundant: the maximal text, which is what the
  // 512-char core constraint has to survive.
  const FULL: InstructionsCtx = {
    imageRedundant: false,
    searchRedundant: false,
    skillsEnabled: true,
    memoryEnabled: true,
    ragEnabled: true,
    tasksEnabled: true,
    imageAvailable: true,
    searchAvailable: true,
    gatewayReady: true,
    delegationReady: true,
  };

  // The core is what Codex reliably shows (it uses the first 512 chars as the
  // namespace description), so the flagship tools must live inside that slice.
  it('leads every profile with design_core, skill_list, and delegate inside the first 512 chars', () => {
    for (const id of Object.keys(PROFILES) as HostId[]) {
      const head = instructionsFor(PROFILES[id], FULL).slice(0, 512);
      expect(head).toContain('design_core');
      expect(head).toContain('skill_list');
      expect(head).toContain('delegate');
    }
  });

  it('keeps the whole core paragraph within the first 512 characters', () => {
    for (const id of Object.keys(PROFILES) as HostId[]) {
      const core = instructionsFor(PROFILES[id], FULL).split('\n\n')[0]!;
      expect(core.length).toBeLessThanOrEqual(512);
    }
  });

  it('keeps Codex substantially leaner than the generic host branches', () => {
    for (const id of Object.keys(PROFILES).filter((id) => id !== 'codex') as HostId[]) {
      const len = instructionsFor(PROFILES[id], FULL).length;
      expect(len).toBeGreaterThan(1400);
      expect(len).toBeLessThan(2600);
    }
    expect(instructionsFor(PROFILES.codex, FULL).length).toBeLessThan(700);
    // Codex deliberately stays shorter than the full generic branch.
    expect(instructionsFor(PROFILES.unknown, FULL).length).toBeLessThan(2300);
    expect(instructionsFor(PROFILES.codex, FULL).length).toBeLessThan(
      instructionsFor(PROFILES.unknown, FULL).length,
    );
  });

  it('tailors the Codex surface end to end', () => {
    const text = instructionsFor(PROFILES.codex, FULL);
    expect(text).toContain('Driving client: OpenAI Codex');
    expect(text).toContain('installed non-Codex engine');
    expect(text).toContain('background:true');
    expect(text).toContain('web.run'); // searchRedundant:false, so the bullet exists
    expect(text).not.toContain('built to be driven'); // retired: server is multi-client now
    expect(text).not.toContain('Claude'); // host-neutral: no capital-C Claude on a non-Claude host
  });

  it('hides generate_image on Codex when its native engine already covers the provider', () => {
    const text = instructionsFor(PROFILES.codex, { ...FULL, imageRedundant: true });
    expect(text).not.toContain('generate_image');
    expect(text).toContain('your native image generation');
  });

  it('drops the web_search bullet when the host natively covers search', () => {
    const text = instructionsFor(PROFILES.codex, { ...FULL, searchRedundant: true });
    expect(text).not.toContain('web_search');
    expect(text).not.toContain('web.run');
  });

  it('tailors the Claude Code surface', () => {
    const text = instructionsFor(PROFILES['claude-code'], FULL);
    expect(text).toContain('Driving client: Claude Code');
    expect(text).toContain('generate_image'); // Claude Code has no native image gen
    expect(text).toContain('installed non-self engine');
    expect(text).not.toContain('built to be driven');
  });

  it('recommends claude or codex when Gemini CLI is the host', () => {
    const text = instructionsFor(PROFILES['gemini-cli'], FULL);
    expect(text).toContain('Driving client: Google Gemini CLI');
    expect(text).toContain('installed non-self engine');
  });

  it('emits no Driving-client line for an unrecognized host', () => {
    const text = instructionsFor(PROFILES.unknown, FULL);
    expect(text).not.toContain('Driving client:');
  });

  it('drops skill_list entirely when skills are disabled, still leading with design_core + delegate', () => {
    const text = instructionsFor(PROFILES.codex, { ...FULL, skillsEnabled: false });
    const head = text.slice(0, 512);
    expect(head).toContain('design_core');
    expect(head).toContain('delegate');
    expect(text).not.toContain('skill_list');
    expect(text).not.toContain('skill_load');
  });

  it('drops the memory tools when memory is disabled', () => {
    const text = instructionsFor(PROFILES.codex, { ...FULL, memoryEnabled: false });
    expect(text).not.toContain('memory_store');
    expect(text).not.toContain('memory_recall');
  });

  it('omits the design bullet when the RAG is disabled', () => {
    const text = instructionsFor(PROFILES.codex, { ...FULL, ragEnabled: false });
    expect(text).not.toContain('design_layer');
  });

  it('does not advertise unavailable Codex additions but retains orientation tools', () => {
    const out = instructionsFor(PROFILES.codex, {
      imageRedundant: false, searchRedundant: false, skillsEnabled: false, memoryEnabled: false,
      ragEnabled: false, tasksEnabled: false, imageAvailable: false, searchAvailable: false,
      gatewayReady: false, delegationReady: false,
    });
    for (const absent of ['design_core', 'skill_list', 'memory_', 'search_tools', 'delegate', 'web_search', 'generate_image', 'background:true']) expect(out).not.toContain(absent);
    expect(out).toContain('write_handoff/recall_handoff');
    expect(out).toContain('project_context');
    expect(out).toContain('doctor');
  });

  it('does not advertise disabled or unavailable generic additions', () => {
    const out = instructionsFor(PROFILES['claude-code'], {
      imageRedundant: false, searchRedundant: false, skillsEnabled: false, memoryEnabled: false,
      ragEnabled: false, tasksEnabled: false, imageAvailable: false, searchAvailable: false,
      gatewayReady: false, delegationReady: false,
    });
    for (const absent of ['design_core', 'skill_list', 'memory_', 'search_tools', 'delegate', 'web_search']) expect(out).not.toContain(absent);
  });

  it('uses a no-engine imagery fallback for Claude and Gemini rather than naming generate_image', () => {
    for (const profile of [PROFILES['claude-code'], PROFILES['gemini-cli']]) {
      const out = instructionsFor(profile, { ...FULL, imageAvailable: false, ragEnabled: true });
      expect(out).toContain('supplied assets or type-led composition');
      expect(out).not.toContain('generate_image');
    }
  });
});

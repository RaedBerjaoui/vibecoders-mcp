/**
 * T28/T32/T33/T34 — the shared, pure doctor renderer.
 *
 * The CLI `status()` and the MCP `doctor` historically rendered different,
 * divergent reports. We extract ONE pure renderer (no I/O — data passed in) so
 * both call sites render identical sections. These tests pin:
 *   T28 — the renderer is pure and emits the expected sections.
 *   T32 — `renderDoctorJson` emits a structured object; glyphs are word-paired.
 *   T33 — an all-empty state appends ONE prioritized call-to-action.
 *   T34 — a legend distinguishes Capabilities from Tool groups.
 */
import { describe, it, expect } from 'vitest';
import {
  renderDoctor,
  renderDoctorJson,
  type DoctorData,
} from '../src/index';

/** A fully-configured fixture exercising every section. */
const full: DoctorData = {
  capabilities: [
    { label: 'Image generation', ready: true, provider: 'OpenAI Codex CLI' },
    { label: 'Web search', ready: false, options: 'gemini-cli, brave-api' },
  ],
  providers: [{ id: 'codex', label: 'Codex CLI', billing: 'ChatGPT plan' }],
  servers: ['github', 'supabase'],
  keys: [
    { name: 'OPENAI_API_KEY', present: true },
    { name: 'BRAVE_API_KEY', present: false },
  ],
  toolGroups: [
    { name: 'memory', label: 'memory', enabled: true },
    { name: 'device', label: 'device', enabled: false },
  ],
  lane: { label: 'vibecoders-mcp@feat/hardening', handoff: '/tmp/h.md' },
  memory: 'Memory: 3 nodes · recall=lexical · default scope=project',
  overlay: 'Private overlay: off (overlay.enabled=false)',
};

/** A fresh, unconfigured machine: no CLIs, no providers, no servers, no keys, defaults only. */
const empty: DoctorData = {
  capabilities: [
    { label: 'Image generation', ready: false, options: 'codex-cli, openai-api' },
    { label: 'Web search', ready: false, options: 'gemini-cli, brave-api' },
  ],
  providers: [],
  servers: [],
  keys: [
    { name: 'OPENAI_API_KEY', present: false },
    { name: 'BRAVE_API_KEY', present: false },
  ],
  toolGroups: [
    { name: 'memory', label: 'memory', enabled: true },
    { name: 'device', label: 'device', enabled: false },
  ],
};

describe('renderDoctor (T28 — shared text renderer)', () => {
  it('renders capabilities, providers, servers, keys, tool groups, lane, memory, overlay', () => {
    const out = renderDoctor(full);
    expect(out).toContain('Image generation');
    expect(out).toContain('OpenAI Codex CLI');
    expect(out).toContain('Web search');
    expect(out).toContain('github');
    expect(out).toContain('OPENAI_API_KEY');
    expect(out).toContain('memory');
    expect(out).toContain('vibecoders-mcp@feat/hardening');
    expect(out).toContain('Memory: 3 nodes');
    expect(out).toContain('Private overlay');
  });

  it('is pure — same input gives byte-identical output, no trailing throw', () => {
    expect(renderDoctor(full)).toBe(renderDoctor(full));
  });

  it('omits sections that were not provided (lane/memory/overlay optional)', () => {
    const out = renderDoctor({ ...full, lane: undefined, memory: undefined, overlay: undefined });
    expect(out).not.toContain('Lane:');
    expect(out).toContain('Image generation'); // still renders the provided sections
  });

  // T32 — accessibility: every glyph is paired with a word, never glyph-only.
  it('pairs each status glyph with a word (on/off, set/unset)', () => {
    const out = renderDoctor(full);
    // tool groups read "on"/"off", not just ✓/· (word adjacent to the glyph+label)
    expect(out).toMatch(/on memory/i);
    expect(out).toMatch(/off device/i);
    // keys read set/unset alongside the glyph
    expect(out).toMatch(/set OPENAI_API_KEY/i);
    expect(out).toMatch(/unset BRAVE_API_KEY/i);
    // never glyph-only: no bare "✓ memory" without a word between
    expect(out).not.toMatch(/✓ memory/);
  });

  // T34 — a legend distinguishes the two disjoint enablement systems.
  it('includes a legend separating Capabilities (provider) from Tool groups (features.* toggle)', () => {
    const out = renderDoctor(full);
    expect(out).toMatch(/Capabilities.*configure a provider/i);
    expect(out).toMatch(/Tool groups.*features\.\*/i);
  });
});

// Host-adaptive: the first line names the driving client, and the disabled-groups
// hint uses THAT host's restart instruction (Codex caches the tool list per
// session, so "restart" is wrong there). Both degrade to safe generics.
describe('renderDoctor — host driver line + restart hint', () => {
  it('renders the driver from data (label + detection/pin suffix)', () => {
    const out = renderDoctor({
      ...full,
      driver: 'OpenAI Codex (detected)',
      restartHint: 'start a new Codex session (Codex caches the tool list per session)',
    });
    expect(out).toContain('driver: OpenAI Codex (detected)');
  });

  it('falls back to "not connected" when no driver is provided', () => {
    expect(renderDoctor(full)).toContain('driver: not connected');
  });

  it('uses the host restartHint in the disabled-tool-groups hint', () => {
    // `full` has device off → the "turn on with … (then …)" hint renders.
    const out = renderDoctor({ ...full, restartHint: 'start a new Codex session' });
    expect(out).toMatch(/then start a new Codex session/);
  });

  it('falls back to a generic restart hint when none is provided', () => {
    expect(renderDoctor(full)).toMatch(/then restart your MCP client/);
  });
});

describe('renderDoctor — T33 all-empty next step', () => {
  it('appends ONE prioritized call-to-action when nothing is configured', () => {
    const out = renderDoctor(empty);
    expect(out).toMatch(/install a delegation cli/i);
    expect(out).toMatch(/codex/i);
  });

  it('does NOT append the call-to-action once anything is configured', () => {
    const out = renderDoctor(full);
    expect(out).not.toMatch(/nothing else is required/i);
  });
});

describe('renderDoctorJson (T32 — structured output)', () => {
  it('emits a structured object with the key sections', () => {
    const j = renderDoctorJson(full);
    expect(Array.isArray(j.capabilities)).toBe(true);
    expect(j.capabilities[0]).toMatchObject({ label: 'Image generation', ready: true });
    expect(j.servers).toEqual(['github', 'supabase']);
    expect(j.keys.find((k) => k.name === 'OPENAI_API_KEY')?.present).toBe(true);
    expect(j.toolGroups.find((g) => g.name === 'memory')?.enabled).toBe(true);
  });

  it('is JSON-serializable (scriptable)', () => {
    expect(() => JSON.stringify(renderDoctorJson(full))).not.toThrow();
  });

  it('flags the all-empty state so a script can detect "configure something"', () => {
    expect(renderDoctorJson(empty).configured).toBe(false);
    expect(renderDoctorJson(full).configured).toBe(true);
  });

  it('passes through the structured host block when hostInfo is provided', () => {
    const j = renderDoctorJson({
      ...full,
      hostInfo: { id: 'codex', label: 'OpenAI Codex', source: 'clientInfo' },
    });
    expect(j.host).toEqual({ id: 'codex', label: 'OpenAI Codex', source: 'clientInfo' });
  });

  it('omits the host block when hostInfo is absent', () => {
    expect(renderDoctorJson(full)).not.toHaveProperty('host');
  });
});

import type { HostProfile } from './profile';

/**
 * Runtime facts the builder needs beyond the static host profile. The server
 * resolves these at startup from config + doctor state, so the text describes
 * the capabilities that ACTUALLY exist this session, not the theoretical max.
 */
export interface InstructionsCtx {
  /** Host natively covers the resolved image provider's engine → don't sell generate_image. */
  imageRedundant: boolean;
  /** Host natively covers web_search (the tool is hidden) → drop the search bullet. */
  searchRedundant: boolean;
  skillsEnabled: boolean;
  memoryEnabled: boolean;
  ragEnabled: boolean;
  tasksEnabled: boolean;
}

const PROVIDERS = ['claude', 'codex', 'gemini'] as const;
type ProviderId = (typeof PROVIDERS)[number];

/** Name used when warning that delegating to yourself just clones the host. */
const SELF_NAME: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
};

/**
 * Build the server's `instructions` string (returned in the MCP initialize
 * result) for one host.
 *
 * Shape: a host-NEUTRAL, self-contained core paragraph kept under 512 chars —
 * Codex attaches this string to every tool as the namespace description and
 * reliably shows only that first slice when deciding how to call the server —
 * then a driving-client line + graceful-degradation note, then host-tailored
 * bullets. Deterministic (no clock, no randomness) so the handshake is stable.
 */
export function instructionsFor(p: HostProfile, ctx: InstructionsCtx): string {
  // ---- Core: neutral, dense, self-contained, ≤512 chars. Flagships, priority order.
  const core = [
    'Vibecoders is an MCP control plane. Tools, highest-value first:',
    'design_core — the anti-AI-design standard for any UI work;',
    ctx.skillsEnabled ? 'skill_list/skill_load — curated engineering playbooks;' : '',
    'delegate — hand a task to another agent CLI on your subscription;',
    'search_tools→load_tool→call_tool — a lazy gateway over mounted MCP servers;',
    'write_handoff/recall_handoff — per-lane continuity;',
    ctx.memoryEnabled ? 'memory_store/memory_recall — a per-user knowledge graph;' : '',
    'project_context and doctor to orient.',
  ]
    .filter(Boolean)
    .join(' ');

  // ---- Orientation: who's driving + the "nothing is required" reassurance.
  const orientation = [
    p.id !== 'unknown' ? `Driving client: ${p.label}.` : '',
    'Everything degrades gracefully — no keys, servers, or provider CLIs required.',
  ]
    .filter(Boolean)
    .join(' ');

  // ---- Imagery sub-line depends on what the host already generates natively.
  const imagery = ctx.imageRedundant
    ? 'Render imagery with your native image generation.'
    : p.native.imageGen
      ? 'Render imagery natively or via generate_image (alternate engine).'
      : 'Render imagery with generate_image.';

  // ---- Delegate targets = the OTHER engines; delegating to yourself just clones you.
  const targets = PROVIDERS.filter((id) => id !== p.selfProviderId);
  const targetList =
    targets.length === 3
      ? `${targets[0]}, ${targets[1]}, or ${targets[2]}`
      : `${targets[0]} or ${targets[1]}`;
  const selfClause = p.selfProviderId
    ? `; delegating to ${p.selfProviderId} spawns a second ${SELF_NAME[p.selfProviderId]}`
    : '';
  // Generic background hint for most hosts; Codex kills foreground MCP calls at
  // ~60s, so there it becomes a hard rule with the config knob attached.
  const tasksLine = !ctx.tasksEnabled
    ? ''
    : p.id === 'codex'
      ? ' Long tasks: always background:true — Codex times out foreground calls near 60s (raise tool_timeout_sec in config.toml); manage via tasks_list / tasks_steer / tasks_interrupt.'
      : ' Add background:true to fire without blocking; manage via tasks_list / tasks_steer / tasks_interrupt.';

  const bullets: string[] = [];

  if (ctx.ragEnabled) {
    bullets.push(
      `• Design above the model's defaults: any UI, page, or component? Call design_core FIRST — the anti-AI-design standard: output that doesn't read as AI-made and holds its formatting (tells principle, build non-negotiables) — then design_layer for the deeper layers (donts tells, formatting laws, directives, scaffolds, type pointers). ${imagery}`,
    );
  }

  if (ctx.skillsEnabled) {
    const skillsExtra =
      p.id === 'codex' ? ' Complements your .agents/skills — the curated vibecoders set.' : '';
    bullets.push(
      `• Reach for a playbook: skill_list shows the set (debugging, TDD, verification, planning, parallel work, code + security review, design); skill_load one before nontrivial work of that kind.${skillsExtra}`,
    );
  }

  bullets.push(
    "• Swallow other MCP servers: don't dump downstream tools into context — search_tools → load_tool → call_tool finds and runs any mounted server's tool on demand; hundreds cost almost nothing.",
  );

  bullets.push(
    `• Delegate on YOUR subscription (not a metered API): list_providers, then delegate a task to ${targetList} — a second engine catches blind spots you'd miss alone${selfClause}. Read-only unless you pass mode:"write".${tasksLine}`,
  );

  if (!ctx.searchRedundant) {
    const webExtra =
      p.id === 'codex'
        ? ' (complements your native web.run, a cached index by default)'
        : '';
    bullets.push(
      `• Search the live web: web_search returns live, grounded, ranked results${webExtra}.`,
    );
  }

  bullets.push(
    '• Carry work across sessions: write_handoff / recall_handoff isolate per lane (cwd + git branch), so concurrent sessions never mix.',
  );

  if (ctx.memoryEnabled) {
    bullets.push(
      '• Remember across sessions: memory_store / memory_recall / memory_walk are a per-user knowledge graph (lexical, or semantic with an embeddings key). Store decisions, facts, gotchas and link them.',
    );
  }

  bullets.push(
    ctx.memoryEnabled
      ? "• Orient fast: project_context returns this repo's branch, recent commits, handoff, and top project memories in one call."
      : "• Orient fast: project_context returns this repo's branch, recent commits, and handoff in one call.",
  );

  bullets.push('• doctor reports exactly what is configured right now.');

  return [core, orientation, bullets.join('\n')].join('\n\n');
}

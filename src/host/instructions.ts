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
  imageAvailable?: boolean;
  searchAvailable?: boolean;
  gatewayReady?: boolean;
  delegationReady?: boolean;
  skillsEnabled: boolean;
  memoryEnabled: boolean;
  ragEnabled: boolean;
  tasksEnabled: boolean;
}

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
  // Codex attaches server instructions broadly. Keep this branch deliberately
  // small and advertise only additive, currently useful Vibecoders surfaces.
  if (p.id === 'codex') {
    const lines = ['Driving client: OpenAI Codex. Use your native image generation, skills, and subagents first. Additions:'];
    if (ctx.ragEnabled) lines.push('design_core/design_layer;');
    if (ctx.skillsEnabled) lines.push('skill_list/skill_load;');
    if (ctx.imageAvailable && !ctx.imageRedundant)
      lines.push('generate_image only as intentionally selected alternate;');
    if (ctx.searchAvailable && !ctx.searchRedundant)
      lines.push('web_search is live alternate to web.run;');
    if (ctx.gatewayReady) lines.push('search_tools/load_tool/call_tool;');
    if (ctx.delegationReady) lines.push('delegate to an installed non-Codex engine (call list_providers); long calls background:true;');
    if (ctx.memoryEnabled) lines.push('memory_store/memory_recall;');
    lines.push('write_handoff/recall_handoff, project_context, doctor.');
    return lines.join('\n');
  }
  // ---- Core: neutral, dense, self-contained, ≤512 chars. Flagships, priority order.
  const core = [
    'Vibecoders is an MCP control plane. Tools, highest-value first:',
    ctx.ragEnabled ? 'design_core — the anti-AI-design standard for any UI work;' : '',
    ctx.skillsEnabled ? 'skill_list/skill_load — curated engineering playbooks;' : '',
    ctx.delegationReady ? 'delegate — hand a task to another agent CLI on your subscription;' : '',
    ctx.gatewayReady ? 'search_tools→load_tool→call_tool — a lazy gateway over mounted MCP servers;' : '',
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
  const imagery = p.native.imageGen
    ? ctx.imageAvailable && !ctx.imageRedundant
      ? 'Render imagery natively; generate_image is an alternate engine.'
      : 'Render imagery with your native image generation.'
    : ctx.imageAvailable
      ? 'Render imagery with configured generate_image.'
      : 'Use supplied assets or type-led composition when no image engine is configured.';

  // ---- Delegate targets = the OTHER engines; delegating to yourself just clones you.
  // Generic background hint for most hosts; Codex kills foreground MCP calls at
  // ~60s, so there it becomes a hard rule with the config knob attached.
  const tasksLine = !ctx.tasksEnabled
    ? ''
    : ' Add background:true to fire without blocking; manage via tasks_list / tasks_steer / tasks_interrupt.';

  const bullets: string[] = [];

  if (ctx.ragEnabled) {
    bullets.push(
      `• Design above the model's defaults: any UI, page, or component? Call design_core FIRST — the anti-AI-design standard: output that doesn't read as AI-made and holds its formatting (tells principle, build non-negotiables) — then design_layer for the deeper layers (donts tells, formatting laws, directives, scaffolds, type pointers). ${imagery}`,
    );
  }

  if (ctx.skillsEnabled) {
    const skillsExtra = '';
    bullets.push(
      `• Reach for a playbook: skill_list shows the set (debugging, TDD, verification, planning, parallel work, code + security review, design); skill_load one before nontrivial work of that kind.${skillsExtra}`,
    );
  }

  if (ctx.gatewayReady) bullets.push(
    "• Swallow other MCP servers: don't dump downstream tools into context — search_tools → load_tool → call_tool finds and runs any mounted server's tool on demand; hundreds cost almost nothing.",
  );

  if (ctx.delegationReady) bullets.push(
    `• Delegate on YOUR subscription (not a metered API): call list_providers, then delegate to an installed non-self engine for a second perspective. Read-only unless you pass mode:"write".${tasksLine}`,
  );

  if (ctx.searchAvailable && !ctx.searchRedundant) {
    const webExtra = '';
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

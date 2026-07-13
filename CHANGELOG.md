# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0]

### Changed

- **The Design RAG is now the anti-AI-design RAG.** `design_core` is reframed
  around one job — make the output NOT read as AI-made and hold its formatting
  across every screen — carrying the tells principle (displace the generative
  BIAS, never the surface instance) and the build non-negotiables. The
  `design_layer` menu is retired-and-replaced: the engine-era layers (`craft`,
  `cards`, `capabilities`, `typography`, `standard`) are removed; the set is now
  `donts` (the vibecoded-tells catalogue), `formatting`, `directives`,
  `scaffolds`, `type_pointers`, and `image_gen`. The tool descriptions, the
  server instructions, `scripts/build-rag-data.mjs`, and the enum↔data parity
  test all move in lockstep.

### Added

- **`concise` skill** ships inside the plugin (`skills/concise/`): a standing
  rule to answer conversational replies in concise, complete plain English,
  reserving long structured output for real deliverables.

## [0.2.0]

### Added

- **Design RAG** — `design_core` and `design_layer`, a brand-agnostic
  design-intelligence layer that lifts Claude's UI/website/component output above
  its generic, templated defaults. `design_core` loads a lean standard plus two
  pre-build gates (derive-everything-from-the-brand, and aliveness); `design_layer`
  pulls deeper craft on demand (`donts`, `craft`, `capabilities`, `typography`,
  `cards`, `image_gen`, `standard`). Imagery composes with the existing
  `generate_image`. On by default (`features.rag`) and delivered on demand, so it
  adds no idle context. Distilled from a curated corpus of elite sites and hardened
  with a blind test (a sandboxed agent must derive a full design from a vague brand
  line, judged against a base-Claude control).

## [0.1.0]

Initial release — an MCP control plane for Claude Code. Secret-free by design,
optional all the way down, fail-closed.

### Added

- **Gateway / meta-tools** — swallow other MCP servers through one gateway:
  `search_tools` → `load_tool` → `call_tool`. Downstream servers mount via
  `servers.json` and load lazily, so hundreds of tools cost almost no context.
- **Delegation** — `list_providers` and `delegate` hand work to the
  `codex` / `gemini` / `claude` CLIs on your own subscription (not a metered
  API). Read-only by default; `mode: "write"` allows file edits.
- **Background tasks** — `delegate` with `background: true` returns a task id
  immediately; manage runs with `tasks_list` / `tasks_steer` / `tasks_interrupt`.
- **Memory graph (RAG)** — `memory_store` / `memory_recall` / `memory_walk` /
  `memory_forget`, a per-user knowledge graph with graph edges. BM25 lexical
  recall with zero keys; optional semantic recall via your own embeddings key.
- **Capabilities** — `generate_image` and `web_search`, resolved per provider
  (CLI option preferred before a bring-your-own-API-key option).
- **Orient** — `project_context` returns the repo's branch, recent commits,
  saved handoff, and top project memories in one call.
- **Reference study** — `reference_inspect` / `reference_excerpt` /
  `reference_read_source`, all SSRF-guarded, size-capped, and timeout-bounded.
- **Cross-session handoffs** — `write_handoff` / `recall_handoff`, isolated per
  working lane (cwd + git branch).
- **Opt-in personal-data tools** (off by default) — `device_search` /
  `chat_history_search` (macOS) and a notes vault (`vault_search` / `vault_read`).
- **CLI** — `vibecoders` with `init` / `register` / `onboard` / `setup` /
  `doctor` / `config` / `vault` / `handoff` subcommands.
- **Claude Code plugin** — `.claude-plugin/plugin.json` + `.mcp.json` register
  the MCP server; a marketplace manifest enables `/plugin` install.

[Unreleased]: https://github.com/vibecoders/vibecoders-mcp/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/vibecoders/vibecoders-mcp/releases/tag/v0.3.0
[0.2.0]: https://github.com/vibecoders/vibecoders-mcp/releases/tag/v0.2.0
[0.1.0]: https://github.com/vibecoders/vibecoders-mcp/releases/tag/v0.1.0

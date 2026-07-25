# Vibecoders MCP

**One MCP that turns your coding agent into your whole dev stack.** It swallows every
other MCP server, delegates across Claude, Codex, and Gemini on *your* CLI
subscriptions (not a metered API), remembers your projects in a searchable knowledge graph, and
carries your setup across sessions — **secret-free by design, and optional all
the way down.**

> Built to optimize vibecoding with **whichever client is driving: Claude Code,
> Codex, or Gemini CLI**. The client stays in charge; Vibecoders gives it
> superpowers: reach any other MCP server, hand work to Codex/Gemini/Claude on the
> plans you already pay for, remember decisions across sessions, orient in a repo
> instantly, design interfaces that escape its own generic defaults, and study any
> reference on the web. Nothing is required to start — no keys, no servers, no
> CLIs. Add only what you want. **Every key is always yours; Vibecoders ships and
> bills none.**

## Quick start (~1 minute, zero config)

**1. Clone, install, build:**

```bash
git clone https://github.com/<you>/vibecoders-mcp
cd vibecoders-mcp
npm install && npm run build
```

**2. Put the `vibecoders` CLI on your PATH** (used throughout this README):

```bash
npm link
```

> Prefer not to link? Skip this step and run every `vibecoders <command>` below
> as `node bin/vibecoders.mjs <command>` from the repo instead.

**3. Register it with your client** (Claude Code shown; full matrix below):

```bash
claude mcp add vibecoders -s user -- node "$(pwd)/dist/index.js"
```

`-s user` registers it once for **every** project (drop it to scope to just this
directory). That's it — it runs with **no keys and no setup**. Ask your agent to run
`doctor` and it will show you exactly what's available and what's optional. The
MCP `doctor` and the `vibecoders doctor` CLI share one renderer, so they report
the same sections; pass `{json:true}` (MCP) or `--json` (CLI) for structured,
scriptable output.

> Config changes and rebuilds take effect on your next client restart.

## Works with Claude Code, Codex, and Gemini CLI

One server, three clients. Vibecoders detects the client driving it and tailors
itself to that client, all inside the `initialize` handshake (before the first
`tools/list`, because Codex ignores `tools/list_changed`).

**Detection precedence.** Config `host.force` wins first, then env
`VIBECODERS_CLIENT`, then the `initialize` handshake's `clientInfo` (a coarse
family match to Codex, Claude Code, or Gemini CLI), then a neutral fallback. Set
`host.adaptive: false` to turn adaptation off entirely.

```json
{ "host": { "force": "codex", "adaptive": false } }
```

**What adapts to the driver.**

- **Instructions.** Per-host and self-contained, with a core kept under 512
  characters, because Codex folds the server instructions into every tool's
  namespace description.
- **Tool visibility.** The driving client sees only useful additions: Codex keeps
  native imagery first and exposes `generate_image` only for a ready alternate
  engine; `web_search` appears there only when a live provider is ready.
- **Tool descriptions.** `delegate` and `web_search` gain per-host advice (under
  Codex, prefer `background:true`, whose foreground MCP calls time out near 60s).
- **`doctor`.** A driver line, host-aware restart hints, and a host block in its
  JSON output.
- **Approvals.** Every tool carries MCP annotations (`readOnlyHint`,
  `destructiveHint`, `openWorldHint`); under Codex, read-only tools auto-proceed
  and destructive ones always prompt.

**Install per client.** Build once (`npm install && npm run build`), then point
each client at the absolute `dist/index.js`:

```bash
# Claude Code
claude mcp add vibecoders -s user -- node "$(pwd)/dist/index.js"
# Codex
codex mcp add vibecoders -- node "$(pwd)/dist/index.js"
# Gemini CLI
gemini mcp add vibecoders node "$(pwd)/dist/index.js"
```

Or register all at once: `vibecoders register --client claude|codex|gemini|all`.

Under Codex, raise the per-call timeout or long `delegate` runs get killed at the
60s default. Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.vibecoders]
tool_timeout_sec = 1200
```

## The tool surface at a glance

Two **separate** enablement systems gate these (the same split `doctor` shows in
its legend): **Capabilities** turn on when you configure a *provider* (a CLI or
your own key); **Tool groups** turn on via a `features.*` toggle. Everything else
is always on.

| Group | Tools | Enablement |
| --- | --- | --- |
| **Gateway** (swallow other MCPs) | `search_tools` · `load_tool` · `call_tool` | always on |
| **Delegate** (other agents, your plan) | `list_providers` · `delegate` (+ `background:true`) | always on (uses CLI auth) |
| **Background tasks** (async delegation) | `tasks_list` · `tasks_steer` · `tasks_interrupt` | tool group `features.tasks` (on) |
| **Memory graph (RAG)** | `memory_store` · `memory_recall` · `memory_walk` · `memory_forget` | tool group `features.memory` (on); semantic recall is opt-in (your key) |
| **Orient** | `project_context` | tool group `features.projectContext` (on) |
| **Research — web** | `web_search` | **capability** — configure a provider (gemini CLI, or Gemini/Brave/Tavily key) |
| **Research — reference** | `reference_inspect` · `reference_excerpt` · `reference_read_source` | tool group `features.reference` (on) |
| **Generate** | `generate_image` | **capability** — configure a provider (codex CLI, or OpenAI/Gemini key) |
| **Design RAG** (escape generic defaults; bring-your-own content) | `design_core` · `design_layer` | tool group `features.rag` (on) |
| **Skills** (curated playbooks) | `skill_list` · `skill_load` | tool group `features.skills` (on) |
| **Handoffs** (per lane) | `write_handoff` · `recall_handoff` | always on |
| **Device** (opt-in · macOS) | `device_search` · `chat_history_search` | tool group `features.device` (off) |
| **Notes vault** (opt-in) | `vault_search` · `vault_read` | tool group `features.vault` (off) |
| **Status** | `doctor` | always on |

## What you get

### 1. Swallow every other MCP server
Instead of every downstream tool flooding context, the driving client sees a few meta-tools
and pulls the rest in on demand: `search_tools` → `load_tool` → `call_tool`.
Mount Playwright, GitHub, Vercel, Supabase, … in `servers.json`; they load
**lazily**, so hundreds of tools cost almost no context.

**Mount a server.** Copy the template and list the servers you want. `servers.json`
is **git-ignored**; put it in the repo root or `~/.vibecoders/`:

```bash
cp servers.example.json servers.json   # then edit it
```

The server resolves it in this order: **`$VIBECODERS_SERVERS`** →
**`~/.vibecoders/servers.json`** → **`./servers.json`** (repo root). See
[`servers.example.json`](./servers.example.json) for annotated examples; a
minimal entry is just a command:

```json
{
  "servers": {
    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@0.0.76"] }
  }
}
```

Reference any secret a server needs by **env-var name** in an `"env": [...]`
array — never paste values. `lazy: true` (the default) keeps a server cold until
first use; set `lazy: false` on the one or two you reach for every session.

**Worked example** — find a tool, load it, and call it:

```
search_tools  { "query": "screenshot" }
              → playwright.browser_take_screenshot — Take a screenshot of the current page
load_tool     { "id": "playwright.browser_take_screenshot" }   # returns its input schema
call_tool     { "id": "playwright.browser_take_screenshot", "args": { "filename": "home.png" } }
```

### 2. Delegate across engines — on your subscription, not the API
The driving client can offload work to an installed non-self coding agent through its **CLI**, so billing
flows through the plan you already pay for:

- **CLI, not API, on purpose.** `delegate` runs `codex exec`, `gemini -p`, or
  `claude -p`. Usage bills through your **Codex/ChatGPT, Gemini, or Claude plan**.
- **Read-only by default.** A delegated agent only edits files with `mode: "write"`.
- **No keys to leak.** The CLIs hold their own auth.
- **Run it in the background.** Pass `background: true` and `delegate` returns a
  task id immediately instead of blocking — manage it with `tasks_list` /
  `tasks_steer` / `tasks_interrupt`, so a long run never stalls the driving client.

**Worked example** — from Codex, hand a write task to Claude (defaults to read-only; opt into edits):

```
delegate  { "provider": "claude",
            "prompt": "Add a --json flag to the doctor command and update its test",
            "mode": "write" }
```

### 3. A memory graph with RAG recall
A per-user knowledge graph that survives every session:

```
memory_store    remember a decision/fact/gotcha; link it to others (graph edges)
memory_recall   find memories by meaning (RAG) — global + this project by default
memory_walk     traverse the links around a node (the context of a decision)
memory_forget   tombstone a memory
```

- **Works with zero keys.** Recall is BM25 lexical out of the box — no provider,
  no setup, fully offline.
- **Semantic when you want it.** Turn on embeddings (`memory.embeddings: true`)
  and recall blends in cosine similarity — using **your own** OpenAI/Gemini key.
  Any failure falls back to lexical, so it never breaks.
- **Scoped.** Memories are `project` (this repo+branch) or `global`, so projects
  don't bleed together. Stored in a plain append-only file — no database engine,
  trivially portable.

**Worked example** — store a decision and link it to the constraint behind it:

```
memory_store  { "kind": "decision",
                "text": "Use BM25 for recall; embeddings stay opt-in",
                "edges": [{ "rel": "because", "text": "must work offline with zero keys" }] }
```

Later, `memory_recall { "query": "why BM25" }` finds it, and
`memory_walk` traverses from that node to the linked constraint.

### 4. Orient instantly — `project_context`
One call returns this repo's branch, recent commits, the saved handoff, and the
project's most recent memories. Reads git state straight from `.git` (no
subprocess), so it's fast even on slow/iCloud-backed dirs.

### 5. Study any reference — `reference_inspect` / `reference_excerpt` / `reference_read_source`
Point at a URL to learn how it's built: title, description, **detected
frameworks/libraries**, headings, and links — or pull a focused text excerpt.
`reference_read_source` is the full-source escape hatch and requires a written
`reason`. All three are **SSRF-guarded** (refuse localhost/private/metadata
addresses, re-check every redirect hop's resolved IP), size-capped, and
timeout-bounded. For learning from a reference, not cloning it.

### 6. Carry work across sessions (lanes)
`write_handoff` / `recall_handoff` save and restore where you left off, **isolated
per working lane** (cwd + git branch), so two sessions in different repos or
branches never clobber each other's notes.

### 7. Opt-in: device search, chat history & a notes vault
Off by default — these read personal data, so you enable them explicitly:

- **`device_search`** — Spotlight (`mdfind`) file search across your Mac (macOS only).
- **`chat_history_search`** — search your *own* past Claude Code sessions
  (`~/.claude/projects` transcripts) by meaning.
- **`vault_search` / `vault_read`** — the **notes vault**: index a local directory
  of notes with the same BM25 ranker as the memory graph; `vault_read` is
  path-guarded to that dir. (Distinct from the **secret vault** below, which
  stores API keys in the OS Keychain.)

```bash
vibecoders config set features.device true   # device_search + chat_history_search (macOS)
vibecoders config set features.vault true
vibecoders config set vault.dir ~/notes      # your notes directory
```

### 8. Design like the best: escape generic AI defaults

`design_core` and `design_layer`: the anti-AI-design RAG — a design-intelligence
layer that lifts the model's UI, website, and component output above the generic,
templated, unmistakably-AI look it reaches for by default. **On by default**
(`features.rag`), and **bring-your-own content**: this package ships the
capability, not the knowledge. The tools load their content at startup from
`~/.vibecoders/design-rag/` (`core.json` + `layers.json`;
`VIBECODERS_DESIGN_RAG_DIR` overrides the path, `VIBECODERS_HOME` moves the
parent). `scripts/build-rag-data.mjs` generates both files from your own
design-knowledge source tree. Without local content the tools stay registered
and answer with a short not-installed note, so nothing breaks.

**How it works.** It is delivered on demand, so it costs almost nothing until a
design task needs it:

- **`design_core`** loads the lean core of your knowledge: your standard plus
  whatever pre-build gates you encode. Call it once at the start of a build.
- **`design_layer`** pulls one deeper layer only when the build needs it:
  `donts` (the vibecoded-tells catalogue), `formatting`, `directives`,
  `scaffolds`, `type_pointers`, and `image_gen`.
- **Imagery follows runtime host policy.** Codex uses native image generation first;
  `generate_image` is used only when listed as a configured alternate/fallback.
  The `donts` layer is filtered to shared guidance plus the driving host.

Always-on cost is one line in the server instructions. The core loads only when a
design task starts, and a layer only when it is pulled, so nothing bloats.

**Worked example** (load the core, pull layers, then use the image capability surfaced to this client):

```
design_core                             # your standard + non-negotiables; do this first
design_layer  { "layer": "donts" }      # your vibecoded-tells self-check catalogue
design_layer  { "layer": "scaffolds" }  # occupancy-correct section scaffolds, pulled when composing
# Codex: use native image generation. Other hosts: call generate_image only when listed.
```

## Skills

Curated, action-language playbooks the driver pulls on demand, so the steps for a
task are in context exactly when the task starts. Two tools, `features.skills`, on
by default:

- **`skill_list`** lists the available skills with their one-line descriptions.
- **`skill_load`** loads one skill's body, with a per-host appendix so the steps
  name the driving client's real tools (Claude Code names, or Codex
  `exec_command`/`apply_patch`/`spawn_agent`/`wait_agent`/`send_message`/`interrupt_agent`/`update_plan`).

**The nine bundled skills:**

- **`concise`**: answer conversational replies in concise, complete plain English.
- **`debugging`**: root-cause discipline before you propose or write a fix.
- **`tdd`**: the red/green/refactor test-first loop.
- **`verification`**: evidence before you claim done, fixed, or passing.
- **`planning`**: write a plan a zero-context engineer could execute.
- **`parallel-work`**: fan work out across agents safely.
- **`code-review`**: review a diff for what breaks, not what looks off.
- **`security-review`**: a security sweep before shipping anything network-facing.
- **`design`**: the anti-generic-AI entry point for any UI or visual work.

Bodies load from the repo's `skills/` plus a user directory: `~/.vibecoders/skills`
overrides a bundled skill by slug, and `VIBECODERS_SKILLS_DIR` pins a directory of
your own. Skills **complement, not replace**, a client's native skill system.

## Customize everything

All non-secret behavior lives in `~/.vibecoders/config.json` (git-ignored). Copy
[`config.example.json`](./config.example.json) or use the CLI:

```bash
vibecoders config path                          # where the file lives
vibecoders config get                           # print the whole config
vibecoders config set memory.embeddings true    # turn on semantic recall (your key)
vibecoders config set memory.defaultScope global
vibecoders config set reference.allowPrivateHosts false
```

**Feature toggles** (`features.*`) turn whole tool groups on/off. `memory`,
`reference`, `projectContext` and `tasks` are **on**; `device` and `vault` are
**off** (they read personal data — opt in). **Resolution order:** built-in
defaults → `config.json` → environment variables.

## Reference setup (how the author runs it)

Vibecoders runs under Claude Code, Codex, or Gemini CLI; the author drives it from **[Claude Code](https://claude.com/claude-code)** in the **[Warp](https://www.warp.dev)** terminal, the reference environment it's designed against. For a concrete starting point, here's the author's own configuration — every entry is a *tool/provider choice*, **never a secret** (keys, when needed at all, live in the Keychain or `.env`, never in the repo):

| Capability | What the author uses | Wire it up |
|---|---|---|
| `delegate` | `codex` · `gemini` · `claude` CLIs on their **subscriptions** (not metered API) | install the CLI, sign in once via the CLI's own login — nothing for Vibecoders to store |
| `image_gen` | **Codex CLI** (ChatGPT / Codex plan) | `vibecoders config set capabilities.image_gen.provider codex-cli` |
| `web_search` | **Gemini CLI** (GoogleSearch, OAuth plan) | `vibecoders config set capabilities.web_search.provider gemini-cli` |
| memory · reference · project_context · tasks | on by default | — |
| device search · notes vault | opt-in (off) | `vibecoders config set features.device true` · `… features.vault true` |

The author's `codex-cli` image pin remains useful when Claude Code drives; when Codex drives, it is ignored as redundant because Codex uses native image generation. The CLI-on-subscription path above needs **zero secrets** — each CLI authenticates itself, and spawned CLIs receive only a non-secret env allowlist by default (`delegation.envMode=minimal`), so an unrelated key in your shell never reaches them. Prefer an API provider instead? Put the key in the Keychain or `.env` per [Bring your own keys](#bring-your-own-keys-never-the-authors) and pin it, e.g. `vibecoders config set capabilities.image_gen.provider openai-api`.

## Bring your own keys (never the author's)

Vibecoders bundles **no** keys and bills **nothing**. You provide your own, only
for the capability that needs one:

- **Secret vault, Keychain-first (recommended, macOS-only):** `vibecoders vault set OPENAI_API_KEY`
  stores the key in the OS Keychain (the **secret vault**) — never written to
  disk, redacted from every log line. (This is the key store; the **notes vault**
  in the opt-in section above is an unrelated text-search feature.) `vault set`
  writes the macOS Keychain only — on Linux/Windows use `.env` instead.
- **Or `.env` (cross-platform):** copy [`.env.example`](./.env.example) and fill it in (git-ignored).
- **Delegation CLIs** (`codex`/`gemini`/`claude`) use **their own** sign-in — there's
  nothing for Vibecoders to store.

Recognized keys (all optional): `OPENAI_API_KEY`, `GEMINI_API_KEY`, `BRAVE_API_KEY`,
`TAVILY_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `VERCEL_TOKEN`,
`SUPABASE_ACCESS_TOKEN`.

## Install as a plugin (MCP server)
This repo is also a Claude Code **plugin** (Codex and Gemini CLI install with their own `mcp add`; see [Works with Claude Code, Codex, and Gemini CLI](#works-with-claude-code-codex-and-gemini-cli) above). `.claude-plugin/plugin.json` is the
manifest, `.claude-plugin/marketplace.json` lists it as a one-plugin marketplace,
and `.mcp.json` registers the MCP server — all auto-discovered on install.

Add the marketplace, then install the plugin from inside Claude Code:

```bash
claude plugin marketplace add RaedBerjaoui/vibecoders-mcp   # or a local path / git URL
```

```
/plugin            # open the plugin browser, pick "vibecoders" → Install
```

`/plugin` (or `claude plugin install vibecoders@vibecoders`) registers the MCP
server for you — no separate `claude mcp add` needed.

## Security — tight, not annoying

- **No secrets in the repo, ever.** `.env`, `servers.json`, `config.json`, and the
  memory store are git-ignored; only blank templates ship.
- **Keychain-first**, redacted from every log line (live values + known token shapes).
- **Fail closed.** A tool that needs a key you haven't set stops with a clear message.
- **No shell injection** anywhere: every subprocess is `spawn(cmd, argsArray)` — never
  a shell string, so delegated CLIs and downstream servers can't be argument-injected.
- **SSRF-guarded fetches.** The reference tools refuse private/loopback/metadata
  targets and re-check every redirect hop's resolved IP.
- **Downstream calls are timeout-bounded**; delegation is read-only unless you opt in.

See [SECURITY.md](./SECURITY.md) for the full threat model.

## How it compares
Vibecoders covers the **developer-productivity** surface of a full agent OS —
memory/RAG, multi-agent delegation, web research, reference study, project
context, handoffs — as an open, secret-free, self-hostable MCP you run with
**your own** accounts. Anything beyond that — browser automation, messaging,
calendars — you add yourself by **mounting** the MCP server you trust through the
gateway; Vibecoders bundles none of it.

## Commands

| Command | What it does |
| --- | --- |
| `vibecoders init` | Build `dist/index.js` and print status |
| `vibecoders register` | Register this server with a client (`--client claude\|codex\|gemini\|all`) |
| `vibecoders onboard` | Guided setup + status |
| `vibecoders setup [capability]` | Guided, read-only per-capability walkthrough |
| `vibecoders doctor [--json]` | Show providers, servers, keys, tool groups, memory, and your lane (same renderer as the MCP `doctor`); `--json` emits structured output for scripts/CI |
| `vibecoders config get/set/path` | Customize non-secret behavior (features, memory, reference); `set` warns on an unknown/typo'd key |
| `vibecoders vault set <NAME>` | Store a secret in the OS Keychain (the secret vault) — **macOS-only**; on Linux/Windows use `.env` |
| `vibecoders vault list` | Show which secrets are set (never the values) |
| `vibecoders handoff recall/write` | Print or save this project's `HANDOFF.md` |

## Docs

- [Private capability overlay](./docs/private-overlay.md) — load owner-local
  tools from a per-machine dir that never ships in the repo.
- [SECURITY.md](./SECURITY.md) — threat model and how to report a vulnerability.
- [CONTRIBUTING.md](./CONTRIBUTING.md) — dev loop, layout, and the release runbook.
- [CHANGELOG.md](./CHANGELOG.md) — what shipped, per version.

## License & attribution

MIT — see [LICENSE](./LICENSE). Third-party dependencies are attributed in
[NOTICE.md](./NOTICE.md).

All key facts confirmed. The critique's corrections hold: `bin` only has `vibecoders` (not `vibecoders-mcp`, so `npx -y vibecoders-mcp` resolves nothing and no bin starts the server); `.mcp.json` boots `dist/index.js` with `packages: 'external'` and no install step; CI runs `npm test` before `npm run build`; version is hardcoded in 3 places. Writing the roadmap.

# Vibecoders MCP — Critical Path to All-S+

Synthesized from 7 per-category assessments + the completeness critique, deduplicated across categories. Grades reflect the critique's corrections (Packaging, Testing, DX revised down). **No dimension is at S+ today**, and three documented install paths are broken before any source-level polish matters.

> Constraints honored: did not run tests/build/mutating commands; verified findings by reading source + cheap greps. The uncommitted tree is **not** counted as a gap.

---

## 1. Scoreboard

<!-- progress -->
> **Progress (feat/hardening):** 44/51 done + the #1 security fix, TDD-covered, 265 tests green, clean linear history. Shipped: ship-blockers + release-trust (T1,T2,T4,T5,T6,T7,T14); connector lifecycle (T8,T9,T17,T20); gateway perf/test (T16,T18,T19,T36); security data-plane + publish guards (T10,T15,T35,T38,T40,T49); codex env dedup (T22); capability hygiene (T21,T24,T25,T26); config/doctor single-source spine (T23,T27,T28,T29,T31,T32,T33,T34,T55); public-readiness docs/legal (T44,T45,T46,T50,T51,T52,T54,T57); OS-aware secret hints (T30); and the **child-process env allowlist** closing the Codex #1 secret-leak (delegation.envMode, default minimal). **DEFERRED backlog (not public blockers):** T39 (coverage thresholds), T41 (token benchmark), T47 (product-name note), T48 (tag-release workflow), T56 (versioned persistence); softer Codex items (gitleaks CI, clean-clone CI test, global-memory opt-in default); and stabilizing the flaky real-subprocess gateway/connector tests under parallel load.

| Category | Current grade | # gaps to S+ | Total effort |
|---|---|---|---|
| Packaging & release readiness | **B-** (was A-) | 9 | 3·blocker + 4·M + 5·S |
| DX & usability | **B+** (was A) | 9 | 2 maj + 2 maj(new) + rest S/M |
| Documentation | **A-** | 9 | mostly S, 2·M |
| Testing | **A-** (was A+) | 7 | 3·maj M, rest S |
| Security & secret hygiene | **A** | 4 | 1 maj M + 3 S |
| Performance & context efficiency | **A** | 6 | 2 maj (M/L), rest S/M |
| Code quality & correctness | **A+** | 7 | all S except 1·M |
| Architecture & organization | **A+** | 4 | 1·M, rest S |
| *CI / automation correctness* (unassessed) | — | 1 | S |
| *Error-recovery / resilience* (unassessed) | — | 1 | M |
| *Upgrade / migration path* (unassessed) | — | 1 | M |
| *CLI accessibility* (unassessed) | — | 1 | M |
| *Legal / attribution* (unassessed) | — | 1 | S |

---

## 2. Critical path to all-S+ (ordered by leverage)

### Tier 0 — Ship-blockers: the advertised install paths don't boot the server
*Nothing else matters until the product installs. Do these first.*

- [x] **T1 — Make a bin that actually starts the MCP server `[S]` `blocker`**
  `npx -y vibecoders-mcp` resolves the bin named after the package; the only bin is `vibecoders` → bin/vibecoders.mjs (the CLI, prints help), and there is **no** bin that launches `dist/index.js`. The entire `npx`/`claude mcp add … npx` path boots nothing.
  Add `"vibecoders-mcp": "dist/index.js"` to `package.json` bin (give dist/index.js a `#!/usr/bin/env node` shebang in build.mjs), **and** correct docs/PUBLISH.md:31 to the working command.
  → `package.json`, `build.mjs`, `docs/PUBLISH.md`, `.mcp.json`

- [x] **T2 — Make the plugin install path resolve its dependencies `[M]` `blocker`**
  build.mjs sets `packages: 'external'`, so dist/index.js does runtime `import` of `@modelcontextprotocol/sdk` + `zod` (17 refs). The npm tarball survives because `npm install` resolves deps — but the plugin path (`.mcp.json` → `node ${CLAUDE_PLUGIN_ROOT}/dist/index.js`) is a git/marketplace **clone with no `npm install`**, no `prepare`/`postinstall`, no `bundledDependencies` → `ERR_MODULE_NOT_FOUND` on every plugin install.
  Recommended: add a **bundled** build for the plugin entry (drop `packages:'external'` for that output, or emit a second `dist/index.bundled.js` and point `.mcp.json` at it). Alternative: add a `prepare` script + document `npm install` in CLAUDE_PLUGIN_ROOT.
  → `build.mjs`, `.mcp.json`, `package.json`, `README.md`

### Tier 1 — Correctness-of-pipeline + the source-level "majors"
*Low-effort, high-leverage. The CI bug means the "197 green" assurance the whole audit rests on is not validating the shipped bundle.*

- [x] **T4 — Fix CI step order: build before test `[S]` `major`**
  ci.yml runs `npm ci → typecheck → test → build`. dist/ is git-ignored, so on a clean runner it's **absent** when tests run; server.integration.test.ts:17-23 spawns `node dist/index.js` with no `existsSync` guard/skip. CONTRIBUTING.md:30 even warns to build first — CI does the opposite. CI is red or green-on-stale-cache, never validating the freshly-typechecked bundle.
  Reorder to build-before-test (or add `"pretest": "npm run build"`, or guard the integration test to build/skip when dist is absent).
  → `.github/workflows/ci.yml`, `tests/server.integration.test.ts`

- [x] **T5 — Add `prepublishOnly`/`prepack` publish guard `[S]` `major`**
  No `prepublishOnly`/`prepack`/`prepare` exists, so `npm publish` seals whatever git-ignored dist/ is on disk — stale or missing — with no rebuild and no gate.
  Add `"prepublishOnly": "npm run build && npm run typecheck && npm test"` (closes Packaging + makes T2's bundled build automatic). Also satisfies the release-trust criterion.
  → `package.json`

- [x] **T6 — Single source of truth for version `[S]` `major`**
  `0.1.0` is hardcoded in 3 places: package.json:3, .claude-plugin/plugin.json:3, and the server handshake src/index.ts:92. Nothing keeps them in lockstep.
  Inject version into src/index.ts at build time (esbuild `define` from package.json), and generate plugin.json's version or add a CI assertion that all three match.
  → `src/index.ts`, `build.mjs`, `.claude-plugin/plugin.json`, `package.json`

- [x] **T7 — `loadServers()` must fail soft like `loadVibeConfig()` `[S]` `major`**
  registry.ts:46-50 does `serversFileSchema.parse(JSON.parse(readFileSync(...)))` with **no try/catch**, run at boot via index.ts:52 — one stray comma in servers.json kills the control plane, directly contradicting the project's own fail-closed discipline (config.ts:106-118 wraps the identical parse and degrades with a stderr note).
  Wrap in try/catch → warn to stderr → return `{}` (treat a broken servers file as "no servers mounted"). *Touches the same file as T16/T17 — do them together.*
  → `src/gateway/registry.ts` (model: `src/capabilities/config.ts`)

- [x] **T8 — Connector.connect: memoize the in-flight promise (fix duplicate-spawn race) `[S]` `major`**
  connector.ts:41-69 reads `clients.get` → `await client.connect` → `set` afterward. Claude Code batches concurrent tool calls, so two first-use calls to the same server both miss the check, both spawn a child + handshake, and the second `set()` orphans the first client — `closeAll()` never closes it, leaking a child.
  Store `Promise<Client>` in the map and `set()` it **synchronously before awaiting**, so concurrent callers share one connect. *This is the foundation for T9 and the perf/eviction work (T20–T22).*
  → `src/gateway/connector.ts`

- [x] **T9 — Connector: evict dead clients on transport close `[M]` `major`**
  Clients are cached for process life; no `onclose`/`onerror`/reconnect anywhere. If a downstream child crashes/OOMs/idle-exits, the stale Client stays cached and **every** later `call_tool` fails until restart, with no self-heal.
  Wire `transport.onclose`/`client.onclose` → delete the map entry (+log); optionally retry-once on closed-transport error in call_tool. *Build on T8's map; complements T22's idle-eviction.*
  → `src/gateway/connector.ts`, `src/gateway/lazyTools.ts`

### Tier 2 — Security & privacy (the data-plane leak + unconsented side effects)

- [x] **T10 — Apply the redactor to the data plane, not just stderr `[M]` `major`**
  `makeRedactor`/`redact` is wired into exactly one call site — the stderr logger (logger.ts:19,23). Every tool **response** is returned unredacted: `call_tool` returns `JSON.stringify(downstream)` (lazyTools.ts:95); `delegate` returns the CLI's raw stdout/stderr (tools.ts:81) from a child inheriting full `process.env`; tasks detail + image/search failure messages embed raw child output. A downstream error echoing an `Authorization` header or a CLI printing `env` leaks verbatim into the transcript — the exact threat this control plane creates.
  The redactor is pure and already exists: build it once from `config.secrets.values()` and wrap `text()`/`errorText()` in util/mcp.ts (or scrub at each boundary return). Add tests asserting a planted token → `***` in a tool result.
  → `src/util/mcp.ts`, `src/gateway/lazyTools.ts`, `src/providers/tools.ts`, `src/tasks/tools.ts`, `src/capabilities/image.ts`, `src/capabilities/search.ts`

- [x] **T14 — Mechanical no-secrets publish guard + secret scan `[S]` `minor`**
  Secret-free publish is currently manual (files[] allowlist + a human-run snippet). files[] ships whole dirs (dist, bin, .claude-plugin).
  Add a `prepack`/vitest that runs `npm pack --dry-run --json` and asserts the file list contains no `.env`/`.env.*` (except `.env.example`), `servers.json`, `config.json`, `*.db`, `.vibecoders/**`, or anything matching `redact.ts` `SECRET_PATTERNS` over the tarball; pair with a gitleaks GitHub Action. *Folds naturally into T5.*
  → `package.json`, `.github/`, `docs/SECURITY.md`

- [x] **T15 — Tighten `SECRET_PATTERNS` (the data-plane fallback) `[S]` `minor`**
  The pattern layer is the fallback for tokens leaking through downstream responses (the T10 case). `sk-` body is `[A-Za-z0-9]` only → misses newer keys with `-`/`_`; no Google OAuth (`GOCSPX-`, `1//`), HF (`hf_`), Slack app (`xapp-`), and `VERCEL_TOKEN` (a managed secret) has no distinctive prefix so it relies entirely on value-scrubbing.
  Widen body class to `[A-Za-z0-9_-]`, add the missing prefixes, and document that value-scrubbing is the guarantee / patterns are best-effort. Add rows to redaction.test.ts.
  → `src/util/redact.ts`, `tests/redaction.test.ts`

### Tier 3 — Performance hot path + the single-source-of-truth refactors

- [x] **T16 — Don't eagerly spawn EVERY downstream server on first `search_tools` `[L]` `major`**
  search_tools does `await Promise.all(serverNames.map(indexServer))` (lazyTools.ts:50) → `connect()` spawns a child per server. The first search cold-boots 6–10 `npx`/node children serialized behind the user, each up to the 60s connect timeout. Context stays lazy; resource/latency footprint is eager — undercutting the headline claim.
  Index from a cheap cached manifest per server (persist to `$VIBECODERS_HOME`, search without connecting); connect only on `load_tool`/`call_tool`. **Wiring `lazy:false` (T19) gives the clean policy**: eagerly connect only `lazy:false` servers at boot. Bound concurrency so one slow server can't stall discovery.
  → `src/gateway/lazyTools.ts`, `src/gateway/connector.ts`, `src/gateway/registry.ts`

- [x] **T17 — Cache `listTools` per server; stop re-listing on every `load_tool` `[M]` `major`** *(merges Code-quality "redundant 2nd listTools" + Perf "no caching")*
  `indexServer` lists tools then throws away inputSchema (ToolIndex stores name+desc only, registry.ts:66-70); `load_tool` then calls `connector.listTools` **a second time** (lazyTools.ts:74) to recover one schema, and `connector.listTools` (connector.ts:72-84) memoizes nothing — so indexing + every load pays a full RPC.
  Cache `DownstreamTool[]` (incl. inputSchema) in Connector keyed by server (invalidate on the T9 disconnect), and have `load_tool` read from memory (map lookup, not network). *Builds directly on T8/T9.*
  → `src/gateway/connector.ts`, `src/gateway/lazyTools.ts`, `src/gateway/registry.ts`

- [x] **T18 — Bound `search_tools` output + use the repo's BM25 ranker `[M]` `minor`**
  search_tools emits each hit with the downstream description verbatim, no per-result truncation or global cap (lazyTools.ts:52) — a 10-hit search of verbose servers can dump thousands of tokens, the exact bloat the gateway exists to prevent. And ToolIndex.search ranks by ad-hoc substring `includes` (registry.ts:81-99) while the repo already has a tested BM25 ranker (memory/rank.ts, reused by device+vault).
  Truncate each description to ~1–2 lines + cap total output; swap ToolIndex.search to `rankBm25`/`tokenize`.
  → `src/gateway/lazyTools.ts`, `src/gateway/registry.ts`, `src/memory/rank.ts`

- [x] **T19 — Wire (or remove) the dead per-server `lazy` flag `[S]` `minor`**
  `serverDefSchema` defines `lazy: z.boolean().default(true)` (registry.ts:21) but **nothing reads `def.lazy`** — a silent no-op tuning knob.
  Wire it (boot: eagerly connect+index `lazy:false`, keep `lazy:true` cold) — which is also the clean lever for T16 — or remove it from schema + servers.example.json.
  → `src/gateway/registry.ts`, `src/index.ts`, `servers.example.json`

- [x] **T20 — Idle-eviction for warm connections `[M]` `minor`**
  Connector holds every client for process life, closed only in `closeAll()` (connector.ts:101-110); a long session holds one idle child per mounted server forever.
  Add an idle TTL that closes + removes a client after N min of no calls (reset on use). *Build on T8/T9's lifecycle.*
  → `src/gateway/connector.ts`

- [x] **T21 — `mdfind` argument-injection guard `[S]` `minor`**
  device/tools.ts:38 passes `query` positionally to `mdfind` via execFile (no shell injection — correct), but a query starting with `-` is parsed as an option.
  Prepend `--`: `['--', query, ...]` (and fix onlyIn position).
  → `src/device/tools.ts`

- [x] **T22 — Centralize codex auth-env-stripping `[S]` `minor`**
  image.ts:156-158 (runCodexOnce) hand-deletes `OPENAI_API_KEY`/`OPENAI_AUTH_TOKEN`, duplicating the provider registry's `env.unset` mechanism (registry.ts:104, applied delegate.ts:70). A third var added to the registry → image gen silently keeps billing the API.
  Factor the codex unset-list into one shared constant the image executor reuses (or route codex image-gen through the provider def).
  → `src/capabilities/image.ts`, `src/providers/registry.ts`, `src/providers/delegate.ts`

### Tier 4 — Single-source-of-truth + uniformity (Architecture/Code-quality polish)

- [x] **T23 — Collapse the 4-place feature-group list into one `FEATURE_GROUPS` table `[M]` `minor`** *(merges Arch "4-place list" + "FeatureName re-states Zod keys")*
  The toggleable group set is hand-kept in 4 spots (Zod `features` config.ts:41-48; `FeatureName` union :82; `FEATURE_DEFAULTS` :83-91; the `groups` array in index.ts:73-79). Union/defaults fail typecheck on mismatch, but the Zod shape and index.ts labels are unchecked free-form — a new group silently misses doctor's status line.
  Define one ordered `const FEATURE_GROUPS = [{name,label,default}] as const` in config.ts; **derive** `FeatureName`, `FEATURE_DEFAULTS`, the Zod shape, and index.ts's featuresLine from it.
  → `src/capabilities/config.ts`, `src/index.ts`

- [x] **T24 — Name the two inline `register*` deps shapes `[S]` `minor`**
  registerTasks (tasks/tools.ts:37) and registerDevice (device/tools.ts:140) use inline `deps:{...}` while the other 8 groups use named `XDeps` interfaces.
  Add `export interface TasksDeps` / `DeviceDeps`. *Same files as T25.*
  → `src/tasks/tools.ts`, `src/device/tools.ts`

- [x] **T25 — Use the injected `log` on catch paths (or drop it) `[S]` `minor`**
  registerDevice/registerVault/registerTasks accept `log` but never use it, and — unlike memory/reference which `log.warn` every caught failure — device_search/vault_read/chat_history_search swallow failures into errorText with no log line, so an operator tailing stderr is blind to them.
  Add `log.warn(...)` on the catch paths (restores uniform observability). *Same files as T24.*
  → `src/device/tools.ts`, `src/vault/tools.ts`, `src/tasks/tools.ts`

- [x] **T26 — Fix the stale `gpt-image-1` section comment `[S]` `minor`**
  image.ts:232 header says `gpt-image-1` but the file header, inline comment, request default (:248 `gpt-image-2`), and capability label all say gpt-image-2.
  One-word fix. *Same file as T22/T10.*
  → `src/capabilities/image.ts`

### Tier 5 — DX & doctor convergence (single source of truth for status)

- [x] **T27 — Resolve `.env` from a stable path (global install + CLI/server agreement) `[M]` `major`** *(new, missed by all agents)*
  env.ts:41 loads `.env` relative to `process.cwd()`. Registered globally (`-s user`), Claude launches the server with cwd = the user's *current project*, so the `.env` users are told to create (the only non-macOS secret path) is silently ignored everywhere else. Worse, the CLI reads `.env` from ROOT (bin:142), so `vault list` reports a key the server can't see — doctor lies.
  Resolve `.env` from `$VIBECODERS_HOME`/package root (honor `$VIBECODERS_ENV`); make CLI and server agree.
  → `src/config/env.ts`, `bin/vibecoders.mjs`

- [x] **T28 — Converge CLI `doctor` and MCP `doctor` (shared renderer) `[M]` `major`**
  CLI `status()` (bin:172-192) prints only CLIs/servers/keys/build; the MCP `doctor` (index.ts:103-129) adds capability matrix, lane, memory, tool-groups, overlay. README:218 oversells the CLI variant. A newcomer's first move (CLI, pre-registration) sees a thinner, different report.
  Extract shared status sections both call sites render identically (or, minimum, correct README:218 to match `status()`).
  → `bin/vibecoders.mjs`, `src/index.ts`, `README.md`

- [x] **T29 — CLI must resolve `servers.json` via the server's 3-tier order `[S]` `major`**
  Server resolves `$VIBECODERS_SERVERS` → `~/.vibecoders/servers.json` → `./servers.json` (registry.ts:33-46), advertised in .env.example:36. CLI hardcodes repo-root only (bin:176), so a user on the documented global path sees servers in Claude but `doctor` reports "(none)".
  Import/replicate `resolveServersPath()` in the CLI. *Pairs with T28.*
  → `bin/vibecoders.mjs`, `src/gateway/registry.ts`

- [x] **T30 — OS-aware secret-setup hints `[M]` `minor`** *(merges DX "macOS-only vault hint" + Doc "Keychain no caveat")*
  Capability hints hardcode `vibecoders vault set …` (registry.ts:31,37,64,70) echoed verbatim in fail-closed output (tools.ts:59,65,104,110), but `vault set` is macOS-only — non-mac users are told to run a command that stores nothing, with no `.env` mention.
  Make the hint OS-aware (append "or add it to .env" / branch on platform), mirroring env.ts. Also add the macOS-only caveat to README:171 + command table.
  → `src/capabilities/registry.ts`, `src/capabilities/tools.ts`, `src/capabilities/types.ts`, `README.md`, `.env.example`

- [x] **T31 — Validate `config set` keys (warn on typos) `[M]` `minor`**
  `config set <dotted.key>` writes any path via setDeep with no allow-list (bin:399-405), so `memory.embedings true` (typo) succeeds, prints a confident "Set", and silently never takes effect — on the headline customization surface.
  Validate `arg` against the known key space (the T23 `FEATURE_GROUPS`/config schema) and warn (non-fatal, "did you mean") on unknown paths. *Benefits from T23.*
  → `bin/vibecoders.mjs`, `src/capabilities/config.ts`

- [x] **T32 — `doctor --json` + accessible labels `[M]` `minor`** *(unassessed category)*
  All status is `✓`/`·` glyphs only (12 in bin, 5 in index.ts) — ambiguous to screen readers, unscriptable, mangled in CI logs.
  Add `vibecoders doctor --json` (+ a structured MCP doctor variant); pair glyphs with words ("on"/"off"); honor `NO_COLOR`/non-TTY. *Pairs with T28's shared renderer.*
  → `bin/vibecoders.mjs`, `src/index.ts`

- [x] **T33 — Prioritized next-step on an all-empty `doctor` `[S]` `minor`**
  A fresh install renders rows of `·` with no top-line call to action, yet `doctor` is the command README tells users to run first.
  Detect the all-unconfigured state and append one prioritized line (e.g. "Install a delegation CLI (codex/gemini/claude) — nothing else is required"). *Same renderer as T28.*
  → `src/index.ts`, `bin/vibecoders.mjs`

- [x] **T34 — Doctor legend: Capabilities vs Tool-groups `[S]` `minor`**
  image_gen/web_search are gated by provider config (matrix) while tool-groups are gated by `features.*` — two disjoint enablement systems with no cross-reference; the README table lists all flat.
  Add a one-line legend distinguishing "Capabilities (configure a provider)" from "Tool groups (features.* toggle)"; align README's "Needs a key?" column. *Same renderer as T28.*
  → `src/index.ts`, `src/capabilities/matrix.ts`, `README.md`

### Tier 6 — Test coverage to back the S+ claims

- [x] **T35 — `tests/fetch.test.ts` for the SSRF-guarded fetcher `[M]` `major`**
  fetch.ts (the most security-critical imperative code) has **no** direct test — reference.test.ts imports only guard.ts predicates + extract.ts. `fetchGuarded`/`resolveSafe`/`pinnedLookup`/`readCapped`/the redirect loop are unexercised; proving `isBlockedAddress()` works ≠ proving the loop calls it on hop N.
  Drive `fetchGuarded` against a loopback `http.Server`: with `allowHosts:['127.0.0.1']` reach it; **without** the override assert a redirect Location → private IP is refused, a >2MB body sets `truncated:true`, non-http scheme + >5 redirects throw, and timeout fires.
  → `src/reference/fetch.ts`, `tests/reference.test.ts`

- [x] **T36 — Gateway search→load→call against a real mounted server `[M]` `major`**
  The flagship path has no e2e: gateway.test.ts unit-tests ToolIndex only, server.integration.test.ts mounts **zero** servers.
  Add a tiny stdio MCP fixture server (few SDK lines, like the `node -e` stand-ins in delegate/tasks tests) wired via `VIBECODERS_SERVERS`; assert search finds its tool, load returns the inputSchema (from cache after T17), call round-trips, and an unknown qualified id yields the "Add it to servers.json" error.
  → `tests/gateway.test.ts`, `tests/server.integration.test.ts`, `src/gateway/lazyTools.ts`

- [x] **T38 — Give `secrets.ts` a fake-exec seam + `tests/secrets.test.ts` `[S]` `major`**
  Keychain wrapper is the lone shell-wrapper without an injectable exec seam (mdfind/delegate/codex/gemini all have one); covered only transitively via the catch→undefined path on CI.
  Add an optional exec-injection param (mirror device/tools.ts `fakeRun`) + a test feeding fake stdout (`'value\n'`→`'value'`, `''`→`undefined`, throw→`undefined`).
  → `src/config/secrets.ts`, `tests/redaction.test.ts`

- [ ] **T39 — Wire `@vitest/coverage-v8` + thresholds in CI `[S]` `minor`**
  Not installed, no `coverage` script, CI doesn't measure it — the suite's strength is unverifiable/unprotected.
  Add the dep, `"coverage": "vitest run --coverage"`, a v8 coverage block (line/branch thresholds, `include: src/**`), and a CI step. *Do after T4 fixes order.*
  → `package.json`, `.github/workflows/ci.yml`

- [x] **T40 — Test `makeEmbedder` branches `[S]` `minor`**
  embed.ts `makeEmbedder(cfg, getSecret)` decides enable/provider/dimension; only a hand-rolled embed fn is injected today, so disabled-default / enabled-no-key→undefined / key-present→Embedder are unasserted.
  Add a small block with a fake `getSecret`.
  → `src/memory/embed.ts`, `tests/memory.test.ts`

- [ ] **T41 — Token-budget benchmark/guard for the meta-tool surface `[M]` `minor`**
  README claims "hundreds of tools cost almost no context" / "zero tokens" with no measurement.
  Add a test/docs benchmark that token-counts the ~25 registered schemas + INSTRUCTIONS (index.ts:26-46) and a typical search/load round-trip, asserting it stays under a budget. *Pairs with T36.*
  → `README.md`, `src/index.ts`, `tests/gateway.test.ts`

### Tier 7 — Docs, release automation, distribution, maintainability

- [ ] **T43 — Refresh stale `docs/SPEC.md` + `docs/PLAN.md` `[M]` `major`**
  Both ship publicly (only HANDOFF.md + docs/superpowers/ are gitignored). PLAN.md marks shipped RAG/delegation as `[ ]` un-done; SPEC.md frames an unshipped "builds & ships apps" scope, contradicting the README.
  Update to what shipped, or add a one-line "historical design notes" header. *Bundle with T42.*
  → `docs/PLAN.md`, `docs/SPEC.md`

- [x] **T44 — Document `servers.json` location + copy step + a 1-server example `[S]` `major`**
  The gateway is the headline feature, yet servers.json's location/copy-from-template/resolution order live only in source + the `onboard` CLI — a reader can't mount a server from the README alone.
  Add a block to README §1: link servers.example.json, state "copy to servers.json (git-ignored) in repo root or ~/.vibecoders/", show a minimal entry.
  → `README.md`, `servers.example.json`

- [x] **T45 — Make the README quickstart copy-paste-safe `[S]` `minor`**
  Body uses bare `vibecoders` before `npm link` is introduced (an aside at :34-36) → "command not found" for a top-to-bottom reader.
  Promote the PATH step into the numbered Quick start, or prefix early examples with `node bin/vibecoders.mjs`.
  → `README.md`

- [x] **T46 — Add `.claude-plugin/marketplace.json` + document `/plugin` install `[S]` `major`**
  README §8 + plugin.json pitch a Claude Code plugin, but there's no marketplace.json → no `claude plugin marketplace add`/`/plugin` path exists. *Verify it boots only after T2/T3.*
  → `.claude-plugin/plugin.json`, `README.md`

- [ ] **T47 — Reconcile the four product names `[S]` `minor`**
  npm `vibecoders-mcp`, plugin `vibecoders`, bin `vibecoders`, server handshake `vibecoders` — the mismatch is *why* `npx -y vibecoders-mcp` breaks (T1) and a marketplace trap.
  Align (T1 adds the `vibecoders-mcp` bin); add a one-line "names" note to README/CONTRIBUTING.
  → `package.json`, `.claude-plugin/plugin.json`, `src/index.ts`, `README.md`

- [ ] **T48 — Tag-triggered release workflow with provenance `[M]` `major`**
  Publishing is a manual laptop `npm publish` (PUBLISH.md:31), no `--provenance`, no git tags, no GitHub Release.
  Add `.github/workflows/release.yml` on `v*` tags: run the gate → `npm publish --provenance --access public` (`permissions: id-token: write`, NPM_TOKEN) → cut a Release.
  → `.github/workflows/ci.yml`/new release.yml, `docs/PUBLISH.md`

- [x] **T49 — Drop the 242kB sourcemap from the published tarball `[S]` `minor`**
  build.mjs:12 `sourcemap:true` + files[] shipping all of dist → dist/index.js.map (242.5kB) is >half the 426kB unpacked size, shipped to consumers who never debug it.
  Gate sourcemap off for the published build, or exclude `*.map` via `.npmignore`. *Coordinate with T2's bundled build.*
  → `build.mjs`, `package.json`

- [x] **T50 — Add a tracked `CHANGELOG.md` + visible release runbook `[S]` `minor`**
  No CHANGELOG (0.1.0 ships with no record of contents); the only runbook is docs/PUBLISH.md, which is git-ignored — external contributors never see how to release.
  Add CHANGELOG.md (Keep a Changelog, seeded 0.1.0) + a tracked RELEASING.md (or fold into CONTRIBUTING.md).
  → `CHANGELOG.md`, `CONTRIBUTING.md`, `.gitignore`

- [x] **T51 — Make `docs/` discoverable from the README `[S]` `minor`**
  README links config/.env/SECURITY/LICENSE but never the docs/ set — private-overlay.md (the overlay feature's only user doc) is unreachable from the README.
  Add a "Docs" list; at minimum link private-overlay.md from §8.
  → `README.md`, `docs/private-overlay.md`

- [x] **T52 — Disambiguate the two "vault" concepts `[S]` `minor`**
  README uses "vault" for both the Keychain **secret** store (`vault set`) and the **notes** feature (`vault_search`/`features.vault`) — unrelated subsystems.
  Name them at first mention: "secret vault (Keychain)" vs "notes vault".
  → `README.md`

- [ ] **T53 — Collapse the duplicate SECURITY docs `[S]` `minor`**
  Root /SECURITY.md (canonical, GitHub-surfaced) and /docs/SECURITY.md diverge (the docs copy makes a "no secret ever committed" claim the root doesn't).
  Keep root canonical; reduce docs/SECURITY.md to a pointer; fold the useful "verify nothing leaks" snippet into root. *Pairs with T14.*
  → `docs/SECURITY.md`, `SECURITY.md`

- [x] **T54 — Worked "first 60 seconds with Claude" examples `[M]` `minor`**
  No copy-pasteable example of the core flows (search_tools→load_tool→call_tool; a `delegate` call w/ mode; a `memory_store` with edges).
  Add 2–3 minimal examples to the relevant README sections. *Pairs with T44.*
  → `README.md`

- [x] **T55 — Cross-reference the split `config` concern `[S]` `minor`**
  config/ (secrets) and capabilities/config.ts (settings) is a correct boundary but a name collision with no signpost.
  Add reciprocal one-line header comments. *Free rider on T23/T27.*
  → `src/config/env.ts`, `src/capabilities/config.ts`

- [ ] **T56 — Stamp a `version`/`schemaVersion` on persisted files `[M]` `minor`** *(unassessed category)*
  config.json, servers.json, the memory store, usage.json carry no version → no migration story for future shape changes (silent reset, or a behavior change with no upgrade note).
  Stamp `version` on write, branch on read, add an "upgrading" note / CHANGELOG migration section. *Pairs with T50.*
  → `src/capabilities/config.ts`, `src/memory/store.ts`, `src/gateway/registry.ts`

- [x] **T57 — Add NOTICE/THIRD-PARTY attribution + real copyright holder `[S]` `minor`** *(unassessed category)*
  MIT LICENSE present, but no third-party attribution for required deps and the holder is a placeholder ("Vibecoders MCP contributors").
  Add a THIRD-PARTY/NOTICE file (or a README license section listing bundled/required deps) and set the real holder. *Pairs with T2 if deps get bundled.*
  → `LICENSE`, new `NOTICE`/`THIRD-PARTY.md`, `README.md`

---

## 3. What "S+" means here (non-obvious cases)

- **Packaging:** every *advertised* install path — npm `npx`, Claude plugin via marketplace, manual `claude mcp add` — actually boots the server on a clean machine, from a freshly-built+gated artifact, with one version string. (Not just "the source builds.")
- **DX:** the tool never lies about its own state — CLI `doctor`, MCP `doctor`, and the README report **one** picture, resolved from the **same** path logic the running server uses, on the user's actual OS.
- **Testing:** every security-critical/headline imperative path (SSRF fetch loop, gateway search→load→call) is exercised **directly**, and CI validates the **freshly-built** bundle with coverage gating regressions.
- **Security:** defense-in-depth on **both** planes — secrets scrubbed from logs **and** from every tool response returned to the model/transcript — with the no-secrets-ship guarantee enforced **mechanically**, not by checklist.
- **Performance:** lazy in **resources**, not just context — a single `search_tools` spawns no child it doesn't need; `load_tool` is a memory lookup; warm children idle-evict and dead ones self-heal; the context-cost claim is benchmarked.
- **Architecture:** the feature-group set, version, and config schema each have exactly **one** declared source; everything else is derived.
- **CI / Upgrade / A11y / Resilience / Legal (unassessed):** CI tests what it ships; persisted state is versioned with a migration path; status has a `--json`/screen-reader-friendly mode; downstream-death self-heals; bundled/required deps are attributed.

---

**Sequencing note:** T1, T2 unblock delivery; T4 makes every green checkmark trustworthy. The gateway Connector (T8→T9→T17→T20) and the doctor renderer (T28→T29,T32,T33,T34) are each a single evolving surface — batch them. Files touched by multiple tasks — `src/gateway/connector.ts`, `bin/vibecoders.mjs`, `src/capabilities/image.ts`, `src/capabilities/config.ts`, `README.md` — are flagged inline so you can do one edit pass per file.
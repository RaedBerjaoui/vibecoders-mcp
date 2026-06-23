# Contributing

Thanks for helping out with Vibecoders MCP! Two principles govern every change:

1. **Secret-free.** No keys, tokens, accounts, or personal paths in the repo —
   ever. Secrets resolve at runtime from the OS Keychain → environment → `.env`
   (see `src/config/env.ts`); only blank `*.example.*` templates ship.
2. **Optional all the way down.** The server must boot and pass tests with **zero**
   configuration. A capability that isn't set up **fails closed** with an
   actionable message ("enable it with: …") — it never throws or crashes.

## Prerequisites

- Node ≥20

## Setup

```bash
npm install
```

## Dev loop

```bash
npm run dev   # tsx watch
```

## Before every commit

All three must pass — **build first**, because the end-to-end test spawns the
bundled `dist/index.js`, so testing before building runs your *previous* build:

```bash
npm run build && npm test && npm run typecheck
```

CI runs the same on Node 20 and 22, plus `npm audit --omit=dev`.

## Releasing

Maintainers cut a release like this:

1. Update [`CHANGELOG.md`](./CHANGELOG.md): move items from `## [Unreleased]`
   into a new versioned section.
2. Bump the version. `npm version <patch|minor|major>` updates `package.json`,
   creates a commit, and tags it (`vX.Y.Z`). Keep `.claude-plugin/plugin.json`
   and `.claude-plugin/marketplace.json` in lockstep.
3. Push the tag: `git push --follow-tags`.
4. Publish: `npm publish --access public`. `prepublishOnly` runs the full gate
   (build + typecheck + test) first, so a broken or stale build can't ship.

The published tarball is secret-free by design — only the `files` allowlist in
`package.json` ships, and `.env`, `servers.json`, `config.json`, and the memory
store are git-ignored.

## Layout

Each `src/` subdirectory owns exactly one concept:

| Dir | Responsibility |
| --- | --- |
| `gateway/` | Swallow other MCP servers (`search_tools`/`load_tool`/`call_tool`) |
| `providers/` | Delegate to Codex/Gemini/Claude CLIs; background tasks |
| `capabilities/` | Capability × provider model (`generate_image`, `web_search`) |
| `memory/` | RAG knowledge graph (store/rank/embed/tools) |
| `reference/` | URL study, SSRF-guarded (fetch/extract/guard/tools) |
| `tasks/` | Manage async background delegations |
| `device/`, `vault/` | Opt-in, personal-data tools (off by default) |
| `context/`, `lanes/`, `overlay/` | project_context · per-lane handoffs · private BYO loader |
| `config/`, `util/` | Config + secrets · shared helpers |

`src/index.ts` wires it all together — read it top-to-bottom for the whole map.
`bin/vibecoders.mjs` is the self-contained CLI (no build step).

## The tool-group pattern

Every group exposes one registrar with the same shape:

```ts
export function registerX(server: McpServer, deps: ...) {
  server.registerTool('x_thing', { description, inputSchema }, async (args) => {
    // build results with text()/errorText() from src/util/mcp.ts
    // log via the redacting logger from src/util/logger.ts (stderr only)
  });
}
```

- **Gate optional groups** behind `featureEnabled(config, 'x')` in `src/index.ts`,
  and add the default to `FEATURE_DEFAULTS` in `src/capabilities/config.ts`.
  Groups that read **personal data** (device, vault) default to **off**.
- **Adding a capability** (one thing with multiple provider options): declare it in
  `src/capabilities/registry.ts`. Resolution is **pinned → priority → fail-closed**,
  and prefers a no-key CLI option before a BYO-API-key one.
- **Never** `spawn` a shell string — always `spawn(cmd, argsArray)`.

## Tests

- Written **test-first** (TDD): every new function or bugfix ships with a
  failing-first test. Tests live in `tests/*.test.ts` and run on
  [vitest](https://vitest.dev).
- **Dir-named** suites (`memory.test.ts`, `providers.test.ts`) bundle the
  pure-logic files of one module. Use a **file-named** suite (`connector.test.ts`)
  only when a single file warrants its own focused tests.
- Keep pure cores unit-tested; the registration layer is covered end-to-end by
  `tests/server.integration.test.ts`.

## House rules

- **Never commit secrets.** `.env`, `servers.json`, and `.vibecoders/` are
  git-ignored. Reference secrets by env-var name only.
- **Keep the public surface clean** — no personal data, paths, or accounts in
  committed files.
- **Keep it dependency-light.** Runtime deps are just `@modelcontextprotocol/sdk`
  and `zod`; keep it that way unless there's a strong reason.
- **Don't rebuild what Claude Code already does** (file search, bash, subagents).
  To reach an external system, **mount** its MCP server through the gateway rather
  than hardcoding it. Owner-local tools belong in the private overlay
  (`docs/private-overlay.md`), never in this repo.

Happy hacking!

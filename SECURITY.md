# Security Policy

## Reporting a vulnerability

- Report privately via GitHub's **"Report a vulnerability"** button under the repo's **Security** tab (private security advisories). Do **not** open a public issue for security reports.
- Expect an initial response within a few days.

## Security model

- **Bring-your-own-keys, nothing bundled.** The server runs with zero keys, servers, or CLIs configured.
- **Keychain-first secrets.** Secrets resolve in order: macOS Keychain (service `vibecoders-mcp`) → environment → `.env`. They are never written to the repo. `.gitignore` blocks `.env`, `servers.json`, `vault/`, key/pem files, and `.vibecoders/`.
- **Redacted logs, stderr only.** Every log line is passed through a redactor that scrubs the live secret values it holds plus known token shapes (Anthropic, all GitHub token types, Google/Gemini `AIza…`, Supabase `sbp_…` and JWTs, OpenAI, Slack, Stripe, npm, AWS, `Bearer` tokens, PEM private-key blocks). stdout is reserved for the MCP protocol.
- **Fail closed.** A tool that needs an absent key throws a clear, actionable error — never a silent or partial leak.

## Threat model — what to understand before mounting servers

- **`servers.json` grants arbitrary code execution by design.** Mounting a downstream MCP server spawns the command you list. Only mount servers you trust, exactly as you would only `npx` a package you trust.
- **Scoped secret forwarding.** A downstream server receives an environment secret **only** if that server explicitly lists the variable name in its `env` array. A server never receives secrets it did not declare. Reference secrets by **name** in `servers.json`, never by value.
- **Bounded downstream calls.** Every downstream connect/list/call is wrapped in a wall-clock timeout (default 60s, `VIBECODERS_TIMEOUT_MS`) so a hung or malicious server cannot wedge the gateway.
- **Delegation runs local CLIs safely.** The `delegate` tool invokes coding-agent CLIs via `execFile` (no shell — the prompt cannot be interpreted as a shell command). Delegated agents are **read-only by default**; file writes require an explicit `mode: "write"`. Delegation bills through your CLI subscription, not an API key.

## Supported versions

The project is pre-1.0; security fixes land on `main`.

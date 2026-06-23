# Private capability overlay (BYO extensions)

Vibecoders can load extra capability modules from a **per-machine** directory that
is never part of the public repo. Use it for tools or content that must run on your
machine but should never ship publicly.

## Where it lives

Resolution order:
1. `$VIBECODERS_PRIVATE_DIR` (explicit path)
2. `overlay.dir` in `~/.vibecoders/config.json`
3. Default: `~/.vibecoders/private/`

The directory is gitignored and referenced by no public code by name. A fresh
`git clone` ships zero private code and zero content.

## Writing a module

Drop a `.mjs` (or `.js`) file in the overlay dir that exports `register`:

```js
// ~/.vibecoders/private/my-cap.mjs
export function register(server, deps) {
  server.registerTool(
    'my_private_tool',
    { description: 'Does something only on my machine.', inputSchema: {} },
    async () => deps.text('result'),
  );
}
```

`deps` is the stable toolkit:

| field | what it is |
|---|---|
| `log` | stderr logger (`log.info/warn/...`) — never write to stdout |
| `config` | the loaded `VibeConfig` |
| `lane` | the current working lane (`{ id, label, cwd, branch }`) |
| `text(s)` | wrap a string as a tool result |
| `errorText(s)` | wrap a string as an error tool result |

Modules load on startup in filename order. A module that throws is logged and
skipped — it never crashes the server. Run `doctor` to see how many loaded.

## Configuration

| key | default | meaning |
|---|---|---|
| `overlay.enabled` | `true` | Load private modules on startup (inert until the dir exists). |
| `overlay.dir` | unset | Override the overlay directory. |

```bash
vibecoders config set overlay.enabled false   # hard-disable
vibecoders config set overlay.dir /path/to/dir # custom location
```

## Trust model

The overlay runs **local code you placed there yourself** — the same trust
boundary as your shell profile. Only put code you wrote or audited in this dir.

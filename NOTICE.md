# Third-party notices

Vibecoders MCP is distributed under the MIT License (see [LICENSE](./LICENSE)).
It bundles **no** API keys and bills nothing; the only third-party code required
at runtime is listed below. Each dependency is the property of its respective
copyright holders and is used under its own license.

## Runtime dependencies

These ship with (or are resolved by) the published package and the plugin build.

| Package | License | Project |
| --- | --- | --- |
| [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| [`zod`](https://www.npmjs.com/package/zod) | MIT | https://github.com/colinhacks/zod |

## Build & development dependencies (not shipped)

Used only to build, type-check, and test the project; not included in the
published runtime. Listed here for completeness.

| Package | License | Project |
| --- | --- | --- |
| [`esbuild`](https://www.npmjs.com/package/esbuild) | MIT | https://github.com/evanw/esbuild |
| [`tsx`](https://www.npmjs.com/package/tsx) | MIT | https://github.com/privatenumber/tsx |
| [`typescript`](https://www.npmjs.com/package/typescript) | Apache-2.0 | https://github.com/microsoft/TypeScript |
| [`vitest`](https://www.npmjs.com/package/vitest) | MIT | https://github.com/vitest-dev/vitest |
| [`@types/node`](https://www.npmjs.com/package/@types/node) | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |

The full text of each license is available in the corresponding package under
`node_modules/<package>/` after `npm install`, or from the linked project page.

## Bundled skills - provenance

The skills under `skills/` are original distillations written for this project.
Each one is our own prose; no third-party text is copied. Where a skill's method
was informed by a public, MIT-licensed collection, that skill carries a
`Credits:` line naming the source. The sources referenced are:

- [`obra/superpowers`](https://github.com/obra/superpowers) (MIT, Copyright (c)
  2025 Jesse Vincent) informed the `debugging`, `tdd`, `verification`,
  `planning`, and `parallel-work` skills.
- [`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills) (MIT)
  informed the `code-review` and `security-review` skills.

The `concise` and `design` skills are wholly ours and carry no third-party
credit. A `Credits:` line acknowledges influence on method only; it does not
indicate any copied text.

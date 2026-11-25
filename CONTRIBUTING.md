# Contributing to cypress-mcp

Bug reports, docs fixes and code are all welcome.

- **First time?** Pick an issue labelled [good first issue](https://github.com/JADEV-CORP/cypress-mcp/labels/good%20first%20issue). Each one says which files to touch and how to check the change. Comment on it so nobody else starts the same one.
- **Bigger change?** Open an issue first, so we agree on the shape before you write it.
- **Question?** Ask in [Discussions](https://github.com/JADEV-CORP/cypress-mcp/discussions), not in an issue.
- **Security problem?** Report it privately, see [SECURITY.md](SECURITY.md).

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Set up

You need Node 22.12 or later (`.nvmrc` pins 22 for nvm and fnm) and git. Cypress is not a dependency: the unit and integration tests run without it.

```bash
git clone https://github.com/<you>/cypress-mcp.git   # your fork
cd cypress-mcp
npm ci
npm run build
npm test
```

## Everyday commands

| Command | What it does |
|---|---|
| `npm run dev` | Rebuild `dist/` on every change |
| `npm test` | All unit and integration tests (Vitest) |
| `npx vitest run test/unit/compact.test.ts` | One test file |
| `npx vitest run -t "fences"` | Tests whose name matches |
| `npm run typecheck` | TypeScript, sources and tests |
| `npm run lint` / `npm run lint:fix` | ESLint |
| `npm run format` | Prettier |

Before you push, run the same check as CI:

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
```

## Try your change in a real client

After `npm run build`, point an MCP client at your build instead of the npm package. For example in the `.mcp.json` of a project that has Cypress:

```json
{
  "mcpServers": {
    "cypress": {
      "command": "node",
      "args": ["/absolute/path/to/cypress-mcp/bin/cypress-mcp.mjs", "--cwd", "/absolute/path/to/your/project"]
    }
  }
}
```

Restart the client after each build. Two shortcuts:

- The CLI prints the same text the tools return: `node bin/cypress-mcp.mjs run cypress/e2e/login.cy.ts --cwd ../my-app`
- The MCP Inspector calls the tools from a browser: `npx @modelcontextprotocol/inspector node bin/cypress-mcp.mjs --cwd ../my-app`

## E2E against real Cypress

`test/e2e/smoke.mjs` drives `test/e2e/project` (CommonJS config, junit reporter) through the built server over stdio, the way an agent does, then the TS (ESM and CJS) and MJS projects in `test/e2e/projects` through the CLI. Run it whenever run, wrapper, runtime or CLI handling changes:

```bash
npm run build
npm install --prefix test/e2e --no-save --no-package-lock cypress@latest @cypress/grep@latest typescript@5 mocha-junit-reporter@2
node test/e2e/smoke.mjs
```

The first install downloads the Cypress binary, a few hundred MB. CI runs the smoke test on every PR anyway, on Cypress 14 (Linux) and the latest Cypress (Linux and Windows), and weekly so a new Cypress release that breaks something is caught before users hit it.

## Where things are

- `src/tools/`: one file per MCP tool. `run.ts` and `get-failure.ts` are the default loop; `src/tools/index.ts` decides which tools each `--caps` group adds
- `src/format/compact.ts`: the text agents read, for the tools and the CLI. `src/format/page.ts`: the untrusted `<page data>` fence
- `src/cli.ts`: the `run`, `doctor`, `list` and `init` commands
- `src/setup/`: `init`. `clients.ts` lists the MCP clients and their config files; `merge.ts` and `toml.ts` add the entry without touching the others
- `src/services/`: process manager, run executor, failure context, output parser, config loader
- `src/utils/`: paths, sanitizing, errors, logger
- `runtime/`: what Cypress loads during a run. `config.cjs` wraps the project's config (it runs in Cypress's config process), `support.js` runs in the browser. Both are plain JavaScript that every supported Cypress and browser must accept; their unit tests run them in Node (`test/unit/runtime-*.test.ts`), the smoke test in a real browser
- `reporter/`: the Mocha reporter Cypress runs with, for progress and per-spec results
- `skill/SKILL.md`: the agent skill shipped with the package
- `test/unit`, `test/integration`: Vitest. `test/e2e`: real Cypress projects and the smoke driver

## Rules that keep agents safe

cypress-mcp puts text from a web app into an agent's context, so a few rules hold for every change. Reviews check them.

- Text from the app under test or from Cypress output goes inside the `<page data>` fence (`fence()` in `src/format/page.ts`). The tests under "text quoted from the app" in `test/unit/compact.test.ts` show how to check it.
- `cypress_get_env` returns keys and types, never values.
- Processes start with `shell: false` and an argument array. A path from a tool argument goes through `resolveInsideRoot` in `src/utils/paths.ts`.
- `browser` must be a name that `cypress info` lists, never a path.

## Adding a client to `init`

1. Add the client to `PROJECT_CLIENTS` (init writes a file in the project) or `OUTSIDE_CLIENTS` (init prints the entry) in `src/setup/clients.ts`, with its name in `CLIENT_NAMES` and, for a project client, its file in `FILES`. Take the path and keys from the client's own docs, and link them in the PR.
2. Add a case to `test/unit/init-clients.test.ts`.
3. Add the client to the Setup section of README.md.

## Adding a new tool

1. Create a file in `src/tools/`, exporting a `register` function that calls `server.registerTool` with a `title`, annotations (`READ_ONLY` or `RUNS_CYPRESS` from `src/tools/result.ts`), an `outputSchema` built with `envelopeSchema`, and a handler that returns `textResult(...)` or `errorResult(...)`
2. Register it in `src/tools/index.ts`. A new tool goes in an optional `--caps` group unless agents need it in every session: each default tool costs context in every client
3. Add tests: the integration tests list the tools and check `structuredContent` against the `outputSchema`
4. Update README.md and `skill/SKILL.md`

## Code style

- TypeScript strict mode, no `any`
- ESM imports with the `.js` suffix
- Prettier and ESLint decide formatting; `npm run format` fixes it
- Every source file starts with the two-line license header (`Copyright (c) 2026 JADEV GROUP SARL` and `SPDX-License-Identifier: Apache-2.0`)
- Comments say why, not what. Messages to agents are short and say what to do next

## Pull requests

- Branch from `main` in your fork (`fix/...`, `feat/...`, `docs/...`). Nothing is pushed to `main` directly.
- One change per PR, with a test for new behavior. Add a line under `## Unreleased` in `CHANGELOG.md` when users would notice the change.
- PR title in conventional commit form (`fix:`, `feat:`, `docs:`, `ci:`, `chore:`; `feat!:` for breaking). Outside PRs are squash-merged, so the title becomes the commit.
- CI must be green: build and tests on Linux, macOS and Windows with Node 22 and 24, E2E on Cypress 14 and latest, and CodeQL. On your first PR, a maintainer approves the CI run before it starts.

Dependabot opens grouped dependency PRs every Monday. The runtime dependencies are bundled into `dist/index.js` and are listed under `devDependencies`, so a bump of one of them (the `bundled` group) only reaches users with the next release: release after a security fix in one of them. `node scripts/audit-prod.mjs` (after `npm run build`) fails on advisories in the bundled packages.

## Releasing (maintainers)

1. Bump `version` in `package.json` and both `version` fields in `server.json` (a unit test fails when they disagree), and turn `## Unreleased` in `CHANGELOG.md` into the version and date
2. Merge to `main`, then push a matching tag on `main`: `git tag v0.5.1 && git push origin v0.5.1`
3. The release workflow checks the tag, builds and packs without publish rights, then publishes to npm with provenance from the `release` environment, creates the GitHub release, and publishes `server.json` to the official MCP Registry

Publishing uses npm trusted publishing (OIDC), so there is no npm token secret. The package's trusted publisher on npmjs.com must name `JADEV-CORP/cypress-mcp`, `release.yml` and the `release` environment. If a version is already on npm, the workflow skips the publish and still creates the GitHub release.

The MCP Registry job logs in with DNS authentication for the `com.jadev-corp` namespace: a TXT record on the jadev-corp.com apex holds the public key, and the matching Ed25519 private key is the `MCP_PRIVATE_KEY` secret of the `release` environment. To rotate it, generate a new key, replace the TXT record (remove the old one, the registry tries a stale record first) and update the secret. The registry checks that the npm package's `mcpName` matches `server.json`, which is why it runs after the npm publish and waits until npm serves the version. It skips versions already in the registry. `mcp-publisher` is pinned in `release.yml` and verified against its Sigstore bundle before it runs.

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0, the same license as the project.

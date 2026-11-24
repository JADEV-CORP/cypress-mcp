# AGENTS.md

cypress-mcp is an MCP server and CLI that runs Cypress for coding agents. TypeScript (strict, ESM), Node 22.12 or later, bundled by tsup into `dist/`. People read [CONTRIBUTING.md](CONTRIBUTING.md); this file is the short version for coding agents working in this repo.

## Commands

```bash
npm ci                                      # install
npm run build                               # dist/ and the third-party notices
npm test                                    # unit and integration tests, no Cypress needed
npx vitest run test/unit/compact.test.ts    # one file
npm run typecheck && npm run lint && npm run format:check && npm test   # what CI runs
```

`node test/e2e/smoke.mjs` runs real Cypress and needs the install step in CONTRIBUTING.md. Run it when run, wrapper, runtime or CLI handling changes.

## Rules

- Text from the app under test or from Cypress output goes inside the `<page data>` fence: `fence()` in `src/format/page.ts`. Cover it with a test like those under "text quoted from the app" in `test/unit/compact.test.ts`.
- `cypress_get_env` returns keys and types. Never add a path that returns env values.
- Spawn with `shell: false` and an argument array. Paths from tool arguments go through `resolveInsideRoot` (`src/utils/paths.ts`).
- Every tool returns text from `src/format/compact.ts` and `structuredContent` that matches its `outputSchema`. A new tool goes in an optional `--caps` group unless every session needs it.
- `runtime/` and `reporter/` are plain JavaScript that runs inside Cypress and the browser: no TypeScript, no npm packages of their own.
- No `any`. Imports end in `.js`. New source files start with the two-line license header the others have.
- Do not edit `dist/` by hand. Change `package-lock.json` only through npm.
- When tools or behavior change, update README.md, `skill/SKILL.md` and the `## Unreleased` section of CHANGELOG.md.
- PR titles use conventional commits: `fix:`, `feat:`, `docs:`, `ci:`, `chore:`, `feat!:` for breaking.

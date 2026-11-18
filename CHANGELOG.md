# Changelog

## 0.2.2 (unreleased)

Fixes for problems agents hit in 0.2.1, and setup docs for every major MCP client.

### Fixes

- `cypress_run_test` no longer reports a pass when the name matches no test. With a title filter and nothing passed or failed, the call fails with code `NO_TEST_MATCHED`, the spec's test titles and the closest matches.
- Cancelling a run now stops it. The request's cancellation kills the whole Cypress process tree (CLI, binary, browser), a run cancelled while queued never starts, and the next run no longer waits behind the cancelled one.
- Runs send a progress notification per test when the client asks for progress.
- A run that hits its timeout keeps what it did: the tests that finished, their failures and the test that was running (`runningTest`) are returned and recorded as the last run.
- `cypress_get_failure_context` marks the line from the error's stack (`location: "cypress/e2e/checkout.cy.js:10:7"`), and every failure gets a spec excerpt. Before, a keyword search could mark the wrong line or find none.
- A spec that does not compile reports the cause (`Module not found: Error: Can't resolve './x'`, syntax and TypeScript errors) in `error`, with `errorKind: "compile"`, and points the agent at the spec instead of `cypress_doctor`.
- `cypress_discover`, `cypress_analyze_spec` and `cypress_list_specs` share one parser and agree on test counts. `cy.visit("...")` is no longer counted as a test, `beforeEach` hooks are no longer lost, nested `describe` blocks are reported as nested, and `.only` / `.skip`, `context`, `specify` and template literal titles are handled.
- `--browser electron` is no longer forced on every run. Without a `browser` argument (or `defaultBrowser` in `cypress-mcp.config.json`) Cypress uses the project's own choice.
- Config changes apply without a restart. The config is reloaded when `cypress.config.*`, a file it imports, the support file or `cypress-mcp.config.json` changes, appears or disappears. Projects that rely on Cypress's default support file now get `@cypress/grep` detected there too.
- `--cwd=<dir>` is accepted as well as `--cwd <dir>`.
- Error results suggest a next step that fits the error instead of always `cypress_doctor`.

### Security

- `cypress_get_env` returns the keys of `cypress.env.json` and the type of each value, never the values. 0.2.1 returned values in clear unless the key name looked sensitive, and kept 4 characters of the ones it masked.
- `browser` accepts only names that `cypress info` lists (plus `electron`), such as `chrome` or `chrome:beta`. Cypress also accepts a path for `--browser` and runs that file, so an agent could run any executable.

### Package

- Runs use `reporter/cypress-mcp-reporter.cjs`, shipped in the package, instead of `--reporter json`. It prints the same JSON report plus one event line per test.
- The `skill/` folder ships in the npm package. The source map no longer does: the tarball is 37.7 kB instead of 62.5 kB.
- `mcpName` in `package.json` and a `server.json` for the official MCP Registry. The release workflow publishes to the registry after npm, with GitHub OIDC, and its actions are pinned to commit SHAs.

### Docs

- README: setup for Claude Code, Claude Desktop, Codex CLI, VS Code, the Copilot cloud agent, Cursor, Windsurf, Gemini CLI, Zed, JetBrains AI Assistant and Junie, with timeout guidance.
- README: a note on two unrelated projects that document this package name.
- Supported Cypress versions now match what CI tests: 14 to 16. PRODUCT.md describes the current project.

## 0.2.1 (2026-11-17)

First npm release since 0.1.1. The 0.2.0 tag never reached npm, so this version also ships everything listed under 0.2.0.

### Security

- `cypress_list_specs` rejects glob patterns with extglob groups such as `+(a|b)`, and patterns over 1,024 characters. picomatch has an open ReDoS advisory on those forms ([GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)) with no patched release yet. Braces like `{a,b}` still work.
- Updated zod to 4.6.7 ([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)), and in the lockfile body-parser to 2.4.0 ([GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828)), fast-uri to 3.1.9 and hono to 4.13.19.

## 0.2.0 (2026-10-19)

### License

- Relicensed from BUSL-1.1 to the **Apache License 2.0**. Free for any use, including commercial use and CI. Added `NOTICE`.

### Security

- Cypress is now started as `node <cypress>/bin/cypress` with no shell. Before, Windows runs used `shell: true` with unquoted arguments, so a crafted test name or spec path could run commands.
- Spec paths outside the project root are rejected by every tool that reads or runs a spec.
- Removed the `npx cypress` fallback, which could download and run an unpinned Cypress version when none was installed.
- Updated `@modelcontextprotocol/sdk` to 1.32 and refreshed the lockfile: `npm audit --omit=dev` reports 0 vulnerabilities (10 before).

### Cypress Cloud compatibility

- `cypress_run_spec` and `cypress_run_test` accept `record`, `tags`, `group` and `ciBuildId` to record runs to Cypress Cloud. The record key is read from `CYPRESS_RECORD_KEY` in the server environment and is never a tool argument.
- Recorded runs return `cloud: { runUrl, projectId, runNumber }`, which Cypress Cloud MCP tools accept directly. Failed recorded runs suggest `cypress_get_failed_tests` with that URL.
- `projectId` is read from the Cypress config, `CYPRESS_PROJECT_ID`, or `cypress-mcp.config.json`.
- New `cypress_get_config` tool reports the resolved config and Cloud readiness. `cypress_doctor` gained a Cypress Cloud check.
- Tool names are guaranteed not to collide with Cypress Cloud MCP tools (enforced by a test).

### Features

- Flaky test detection: every test reports `attempts` and `flaky` (failed, then passed on retry), and run stats include a `flaky` count.
- Cypress 16 support: env values and the grep filter are passed as JSON through `--env`, plus `--expose` on Cypress 15.10+ for `@cypress/grep` 7. Commas, quotes and string types are preserved.
- Cypress is resolved like any Node module, so hoisted installs in monorepos work.
- The server reports its real package version.

### Fixes

- The `cypress-mcp` bin entry is back in the package.
- `stats.skipped` was always 0.
- The JSON report is found even when the app or Cypress prints braces before it.
- Screenshots are looked up in the configured folder even when the config was created after the server started.
- A running Cypress process is killed when the MCP client disconnects.

### Breaking

- Node.js 22.12 or newer is required. Node 18 and 20 are end of life.
- Cypress must be installed in the project (or a parent workspace). There is no npx fallback.
- Unused `authCommand` and `authTokenPath` config fields were removed.

## 0.1.1 (2026-03-25)

- Standardized the response envelope (`ok`, `tool`, `summary`, `data`, `nextActions`) across tools and removed unused tools.
- Startup failures are reported separately from test failures, with clearer diagnostics.

## 0.1.0 (2026-03-24)

Initial release.

### Features

- **Core tools**: `cypress_run_spec`, `cypress_run_test`, `cypress_list_specs`, `cypress_get_config`
- **Debug tools**: `cypress_get_screenshot`, `cypress_get_last_run`, `cypress_get_test_replay`, `cypress_clear_downloads`
- **Auth tools**: `cypress_check_auth`, `cypress_authenticate`, `cypress_get_env`
- **Project tools**: `cypress_validate_config`, `cypress_get_support_file`, `cypress_install`
- **Discovery tools**: `cypress_discover`, `cypress_analyze_spec`
- Auto-detection of Cypress project configuration
- Serial execution with timeout safety
- Cross-platform support (Windows, macOS, Linux)
- Structured JSON output with failure details and screenshot paths

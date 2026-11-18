# cypress-mcp

An open source (Apache-2.0) MCP server that lets AI coding agents run and debug Cypress tests on the developer's machine.

## The problem

Agents write Cypress tests but cannot see them run. Without a runner they guess, or the developer copies terminal output back and forth: run `npx cypress run --spec X`, wait, paste, repeat. Raw Cypress output is also a poor input for an agent: ANSI tables, long stacks from inside the Cypress binary, screenshots on disk with no link to the failure.

## What it does

The agent calls tools; cypress-mcp starts Cypress with the project's own config, waits for the result and returns structured data: counts, failures with error, diff, file and line, screenshot paths, flaky tests, and the next useful call.

| Area | Tools |
|------|-------|
| Run | `cypress_run_spec`, `cypress_run_test` (one test by title, through `@cypress/grep`), `cypress_rerun_last` |
| Inspect | `cypress_get_failure_context`, `cypress_get_screenshot`, `cypress_get_last_run` |
| Discover | `cypress_discover`, `cypress_analyze_spec`, `cypress_list_specs` |
| Setup | `cypress_get_config`, `cypress_get_env`, `cypress_doctor` |

Runs report progress per test to clients that ask for it, stop when the client cancels the request, and keep their partial results when they hit the timeout. Runs can be recorded to Cypress Cloud (`record: true`); the result carries the Cloud run URL that Cypress Cloud MCP tools accept. No tool name overlaps with Cypress Cloud MCP, so agents can load both.

## How it works

- **Transport**: stdio. The client starts `cypress-mcp --cwd <project>` as a child process.
- **Runs**: `node <project>/node_modules/cypress/bin/cypress run --spec ...`. No shell on any platform, every argument passed verbatim. One run at a time; later calls queue.
- **Results**: a small Mocha reporter shipped in the package (`reporter/cypress-mcp-reporter.cjs`) prints the same JSON report as Mocha's `json` reporter, plus one event line per test for progress and timeouts.
- **Config**: read from `cypress.config.*` (and its relative imports) and an optional `cypress-mcp.config.json`, and reloaded when any of those files change.
- **Boundaries**: spec paths must stay inside the project root; `browser` must be a name `cypress info` lists; `cypress_get_env` returns keys and types only; the Cypress Cloud record key is read from the server environment and never passes through the agent.

## Principles

1. **Zero config for standard projects.** A `cypress.config.*` and specs are enough.
2. **Structured output over logs.** The agent gets the cause, the place and the next call, not a terminal dump.
3. **Respect the project.** Its config, browser choice and support file are used as they are. Nothing is written into the project.
4. **Safe by default.** No shell, no paths outside the project, no secrets in tool results, no npx fallback that downloads an unpinned Cypress.
5. **Every run ends.** A hard timeout, client cancellation and client disconnect all stop the whole Cypress process tree.

## Supported

- Cypress 14 to 16. CI runs the end-to-end suite on Cypress 14 and the latest release.
- Node.js 22.12 or newer.
- Windows, macOS and Linux.
- Any MCP client that runs local stdio servers. See the README for per-client setup.

## Not in scope

- Replacing `cypress run` in CI or Cypress Cloud (dashboards, parallelization).
- General browser automation (use a browser MCP server).
- Writing tests. The agent writes them; this server runs them.

## Roadmap

- **0.3.0, agent first.** Compact text results with full data in `structuredContent` and an `outputSchema`; a `runId` on every inspection tool; server `instructions`, tool titles and annotations; a smaller default tool set; dependencies bundled for a faster `npx` start; a `cypress-mcp run <spec>` CLI with the same output.
- **0.4.0, failure context.** DOM and ARIA outline, console errors and failed requests at the point of failure; screenshots as resource links; several specs in one Cypress launch; component testing.

## License

Apache License 2.0. Copyright (c) 2026 JADEV GROUP SARL. See LICENSE and NOTICE.

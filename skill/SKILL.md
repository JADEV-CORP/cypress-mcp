---
name: cypress-testing
description: Run, debug and write Cypress E2E tests with cypress-mcp (MCP tools cypress_run, cypress_get_failure, cypress_list_specs, cypress_doctor) or its CLI (npx cypress-mcp run <spec>). Use when a task involves Cypress specs, a failing E2E test or checking a frontend change in the browser.
metadata:
  priority: 9
  pathPatterns:
    - '*.cy.ts'
    - '*.cy.js'
    - '*.cy.tsx'
    - '*.cy.jsx'
    - 'cypress/**'
    - 'cypress.config.*'
    - 'cypress-mcp.config.json'
  bashPatterns:
    - 'cypress'
    - 'cy\.'
    - 'cypress-mcp'
  importPatterns: []
  promptSignals:
    phrases:
      - "cypress test"
      - "e2e test"
      - "run test"
      - "debug test"
      - "test failure"
      - "write test"
      - "test this feature"
      - "run the tests"
      - "why is this test failing"
      - "screenshot"
    allOf: []
    anyOf: []
    noneOf: []
    minScore: 5
---

# Cypress testing with cypress-mcp

cypress-mcp runs the project's own Cypress and gives back a short result: one block per failure with `file:line`, the error and the screenshot path, plus a `runId`. The server sends these five lines as its instructions:

```text
cypress-mcp runs this project's Cypress tests and reports failures compactly.
- cypress_run {spec} runs a spec (testName for one test) and returns one line per failure (file:line, error, screenshot) and a runId.
- cypress_get_failure {runId} adds source excerpts, diffs and stacks; view "tests", "screenshots" or "output" for more. Pass your own runId: "last" can be another agent's run.
- cypress_list_specs lists specs (titles: true for test names). Fix the cause in the app or the test; a test that passes only on retry is still broken.
- cypress_doctor checks the setup and starts Cypress (about 15 s): use it when a run cannot start, not at every session.
```

## Tools

| When | Call |
|------|------|
| Find the spec for a feature | `cypress_list_specs` (`titles: true` to see test titles) |
| Run a spec | `cypress_run {spec}` |
| Run one test | `cypress_run {spec, testName}` (needs `@cypress/grep` in the project) |
| A test failed and the run result is not enough | `cypress_get_failure {runId}` |
| See every test of a run | `cypress_get_failure {runId, view: "tests"}` |
| Screenshot paths | `cypress_get_failure {runId, view: "screenshots"}` |
| Cypress crashed before the tests ran | `cypress_get_failure {runId, view: "output"}`, then `cypress_doctor` if the output does not explain it |

With a shell instead of MCP: `npx cypress-mcp run <spec> [--test <name>] [--verbose] [--json]`. Same output; exit code 0 when everything passed, 1 when a test failed or the run did not complete, 2 for bad arguments or a missing spec.

## The loop

1. Run the spec that covers the change: `cypress_run {spec}`.
2. Read the result. Each failure already has the line, the error and the screenshot path; often that is enough to fix it.
3. When it is not, call `cypress_get_failure` with the `runId` from step 1. It adds a few lines of source around the failing line, the expected and actual values, the stack and the screenshot path. It reports what Cypress saw at the failure; it does not know why the app behaved that way, so read the app code as well.
4. Fix, then run the same `cypress_run` call again. Keep using the `runId` each run returns: another agent sharing the server can start runs too, and `"last"` would then point at theirs.

Screenshots are PNG files on disk. Open one if you have a tool that reads images; otherwise rely on the error and the excerpt.

## When a run does not complete

- `ERROR ... the spec did not compile`: the message names the file and the import or syntax problem. Fix it in the spec or the file it imports. The doctor will not find anything more.
- `TIMEOUT ... while running "<test>"`: that test hung (a `cy.wait` on a request that never came, an element that never appears). Fix it, or pass a larger `timeout` when the test is slow on purpose.
- `NO MATCH`: no test title contains `testName`. Use one of the titles listed, or `cypress_list_specs {titles: true}`.
- Cypress stopped for another reason: read `view: "output"`, then run `cypress_doctor`. It starts Cypress once to load the config, so it takes about 15 seconds.

## Deciding what to fix

A failing test is a report, not a verdict. Look at what the test expects and what the app did:

- The app is wrong (a regression, a missing feature): fix the app.
- The test is wrong (an outdated selector or text, a wrong expectation after an intended change): fix the test, and say so.
- Unsure: say what you found and ask before changing either.

A test that passed only on a retry (`flaky` in the result) is not fixed. Look for the race: an assertion that runs before a request finishes (wait on an intercept alias), an animation, a selector that matches the wrong element while the page loads.

## Writing tests

- Read a neighbouring spec first and follow its conventions (page objects, custom commands, fixtures, selectors).
- Prefer the project's test attributes (`data-cy`, `data-test`, `data-testid`) over CSS classes and text that changes.
- Wait on aliases (`cy.intercept(...).as("x")`, `cy.wait("@x")`) rather than fixed delays.
- Keep tests independent of each other; set up state in `beforeEach`.
- Run the new spec with `cypress_run` before you call the work done.

## Cypress Cloud

`cypress_run {spec, record: true}` records the run when the project has a `projectId` and the server has `CYPRESS_RECORD_KEY` in its environment. The result has the Cloud run URL; Cypress Cloud MCP tools (`cypress_get_failed_tests`, `cypress_get_flaky_tests`) accept it. Never ask the user to paste the record key into the chat.

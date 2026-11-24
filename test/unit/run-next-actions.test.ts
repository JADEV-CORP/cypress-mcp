import { describe, it, expect } from "vitest";
import { runNextActions } from "../../src/tools/run.js";
import { runStatus } from "../../src/format/compact.js";
import type { RunOutcome } from "../../src/services/run-executor.js";
import type { CypressRunResult } from "../../src/types/results.js";

function completed(result: Partial<CypressRunResult>): RunOutcome {
  return {
    type: "completed",
    record: {
      runId: "run_3",
      kind: "run_spec",
      spec: "cypress/e2e/login.cy.ts",
      specs: ["cypress/e2e/login.cy.ts"],
      projectRoot: "/work/shop",
      prefix: "",
      contextCaptured: true,
      args: { spec: "cypress/e2e/login.cy.ts" },
      result: {
        success: false,
        stats: {
          tests: 1,
          passing: 0,
          failing: 1,
          pending: 0,
          skipped: 0,
          flaky: 0,
          duration: 1000,
        },
        tests: [],
        failures: [
          {
            title: "logs in",
            fullTitle: "Login logs in",
            error: "Expected login to succeed",
            stack: "",
          },
        ],
        screenshots: [],
        videos: [],
        ...result,
      },
      stdoutTail: "",
      stderrTail: "",
      timestamp: 0,
    },
  };
}

function actions(outcome: RunOutcome): string[] {
  return runNextActions(outcome, runStatus(outcome));
}

describe("runNextActions", () => {
  it("points recorded failures and flaky tests at Cypress Cloud MCP", () => {
    const runUrl = "https://cloud.cypress.io/projects/abc123/runs/42";
    const failed = actions(completed({ cloud: { runUrl } }));

    expect(failed[0]).toBe(
      'cypress_get_failure {"runId":"run_3"} for source excerpts, diffs and stacks',
    );
    expect(failed).toContain(`Cypress Cloud MCP: cypress_get_failed_tests for ${runUrl}`);

    const flaky = actions(
      completed({
        success: true,
        failures: [],
        stats: {
          tests: 1,
          passing: 1,
          failing: 0,
          pending: 0,
          skipped: 0,
          flaky: 1,
          duration: 1,
        },
        cloud: { runUrl },
      }),
    );
    expect(flaky).toContain(`Cypress Cloud MCP: cypress_get_flaky_tests for ${runUrl}`);
  });

  it("does not mention Cloud MCP for local runs", () => {
    expect(actions(completed({})).join(" ")).not.toContain("Cloud");
  });

  it("sends a spec that does not compile to the spec, not the doctor", () => {
    const next = actions(
      completed({ failures: [], error: "Module not found", errorKind: "compile" }),
    );
    expect(next).toEqual([
      "fix the error in the spec or a file it imports, then run again",
    ]);
  });
});

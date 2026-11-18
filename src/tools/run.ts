// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { ToolContext } from "../types/index.js";
import { executeCypressRun, type RunOutcome } from "../services/run-executor.js";
import {
  buildFailureContexts,
  type FailureContext,
} from "../services/failure-context.js";
import { renderRun, runHeadline, runStatus, type RunStatus } from "../format/compact.js";
import {
  buildRunArgs,
  cloudOptionsShape,
  progressNotifier,
  runOptionsShape,
} from "./run-shared.js";
import { RUNS_CYPRESS, envelopeSchema, errorResult, textResult } from "./result.js";

const TOOL = "cypress_run";

/** Lines of source either side of a failure in cypress_get_failure. */
export const EXCERPT_RADIUS = 3;

const statsSchema = z.object({
  tests: z.number(),
  passing: z.number(),
  failing: z.number(),
  pending: z.number(),
  skipped: z.number(),
  flaky: z.number().describe("Passed only after a retry"),
  duration: z.number().describe("ms"),
});

export const runDataSchema = z.object({
  spec: z.string(),
  testName: z.string().optional(),
  status: z.enum(["passed", "failed", "error", "timeout", "no_match"]),
  stats: statsSchema,
  failures: z.array(
    z.object({
      index: z.number().describe("1-based, as cypress_get_failure's failure argument"),
      title: z.string(),
      fullTitle: z.string(),
      errorName: z.string().optional(),
      error: z.string(),
      location: z.string().optional().describe("file:line:col, project relative"),
      diff: z.string().optional(),
      screenshot: z.string().optional().describe("Absolute path"),
    }),
  ),
  tests: z.array(
    z.object({
      fullTitle: z.string(),
      state: z.enum(["passed", "failed", "pending", "skipped"]),
      duration: z.number(),
      attempts: z.number(),
      flaky: z.boolean().optional(),
    }),
  ),
  screenshots: z.array(z.string()),
  error: z.string().optional(),
  errorKind: z.enum(["compile", "timeout"]).optional(),
  runningTest: z.string().optional(),
  cloud: z
    .object({
      runUrl: z.string(),
      projectId: z.string().optional(),
      runNumber: z.number().optional(),
    })
    .optional(),
  closestMatches: z.array(z.string()).optional(),
  testTitles: z.array(z.string()).optional(),
});

export type RunData = z.infer<typeof runDataSchema>;

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    TOOL,
    {
      title: "Run Cypress spec",
      description:
        "Run one Cypress spec headless, or one test with testName. Returns one line per failure (file:line, error, screenshot) and a runId for cypress_get_failure. Passing tests are omitted unless verbose.",
      inputSchema: z.object({
        spec: z.string().min(1).describe("Spec path, relative to the project root"),
        testName: z
          .string()
          .min(1)
          .optional()
          .describe("Only tests whose title contains this (needs @cypress/grep)"),
        verbose: z.boolean().optional().describe("Also list passing tests"),
        ...runOptionsShape,
        ...cloudOptionsShape,
      }),
      outputSchema: envelopeSchema(runDataSchema),
      annotations: RUNS_CYPRESS,
    },
    async ({ verbose, ...input }, request) => {
      try {
        const { spec, args } = await buildRunArgs(ctx, input);
        const progress = progressNotifier(request);
        const outcome = await executeCypressRun(ctx, {
          kind: args.grep ? "run_test" : "run_spec",
          spec,
          args,
          testName: args.grep,
          signal: request.mcpReq.signal,
          onProgress: progress.onProgress,
        });
        await progress.flush();
        return await runResult(ctx, outcome, verbose === true);
      } catch (err) {
        return errorResult(TOOL, err, ctx.logger);
      }
    },
  );
}

/** Text and structured result of a finished run. Also used by the CLI. */
export async function runResult(
  ctx: ToolContext,
  outcome: RunOutcome,
  verbose: boolean,
): Promise<CallToolResult & { structuredContent: { data: RunData } }> {
  const failures = await buildFailureContexts(outcome.record, ctx.projectRoot, null);
  const status = runStatus(outcome);
  const nextActions = runNextActions(outcome, status);
  const text = renderRun(outcome, failures, {
    projectRoot: ctx.projectRoot,
    verbose,
    nextActions,
  });
  const data = runData(outcome, failures, status);
  const isError = status === "error" || status === "timeout" || status === "no_match";

  const result = textResult(
    text,
    {
      ok: !isError,
      tool: TOOL,
      runId: outcome.record.runId,
      summary: runHeadline(outcome),
      data,
      nextActions,
    },
    isError,
  );
  return result as CallToolResult & { structuredContent: { data: RunData } };
}

function runData(
  outcome: RunOutcome,
  failures: readonly FailureContext[],
  status: RunStatus,
): RunData {
  const { record } = outcome;
  const { result } = record;
  return {
    spec: record.spec,
    ...(record.args.grep ? { testName: record.args.grep } : {}),
    status,
    stats: result.stats,
    failures: failures.map((failure) => ({
      index: failure.index,
      title: failure.title,
      fullTitle: failure.fullTitle,
      ...(failure.errorName ? { errorName: failure.errorName } : {}),
      error: failure.error,
      ...(failure.location ? { location: failure.location } : {}),
      ...(failure.diff ? { diff: failure.diff } : {}),
      ...(failure.screenshot ? { screenshot: failure.screenshot } : {}),
    })),
    tests: result.tests.map((test) => ({
      fullTitle: test.fullTitle,
      state: test.state,
      duration: test.duration,
      attempts: test.attempts,
      ...(test.flaky ? { flaky: true } : {}),
    })),
    screenshots: [...result.screenshots],
    ...(result.error ? { error: result.error } : {}),
    ...(result.errorKind ? { errorKind: result.errorKind } : {}),
    ...(result.runningTest ? { runningTest: result.runningTest } : {}),
    ...(result.cloud ? { cloud: result.cloud } : {}),
    ...(outcome.type === "no_match"
      ? {
          closestMatches: [...outcome.closestMatches],
          testTitles: outcome.titles.slice(0, 100),
        }
      : {}),
  };
}

/**
 * What to do next, by outcome. cypress_doctor launches Cypress (about 15 s)
 * and finds nothing wrong with a spec that fails or does not compile, so it
 * is only suggested when Cypress stopped for an unexplained reason.
 */
export function runNextActions(outcome: RunOutcome, status: RunStatus): string[] {
  const { record } = outcome;
  const { result, runId } = record;
  const failure = `cypress_get_failure {"runId":"${runId}"}`;
  const actions: string[] = [];

  switch (status) {
    case "failed":
      actions.push(`${failure} for source excerpts, diffs and stacks`);
      break;
    case "passed":
      if (result.stats.flaky > 0) {
        actions.push("a pass on retry is not a fix: find the race, then run again");
      }
      break;
    case "no_match":
      actions.push(
        "cypress_run with testName set to one of the titles above, or without testName for the whole spec",
      );
      break;
    case "timeout":
      actions.push(
        result.runningTest
          ? `fix the test that hung, or pass a larger timeout`
          : "pass a larger timeout",
      );
      if (result.stats.failing > 0) actions.push(failure);
      break;
    case "error":
      if (result.errorKind === "compile") {
        actions.push("fix the error in the spec or a file it imports, then run again");
      } else {
        actions.push(
          `cypress_get_failure {"runId":"${runId}","view":"output"} for Cypress's output`,
          "cypress_doctor if the output does not explain it (launches Cypress, about 15 s)",
        );
      }
      break;
  }

  // A recorded run is also queryable through Cypress Cloud MCP, which adds
  // Test Replay and history across runs.
  const runUrl = result.cloud?.runUrl;
  if (runUrl && result.stats.failing > 0) {
    actions.push(`Cypress Cloud MCP: cypress_get_failed_tests for ${runUrl}`);
  }
  if (runUrl && result.stats.flaky > 0) {
    actions.push(`Cypress Cloud MCP: cypress_get_flaky_tests for ${runUrl}`);
  }
  return actions;
}

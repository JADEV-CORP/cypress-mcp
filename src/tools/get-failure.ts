// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs/promises";
import { z } from "zod";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { ToolContext } from "../types/index.js";
import { LAST_RUN, type RunRecord } from "../services/state-store.js";
import { buildFailureContexts } from "../services/failure-context.js";
import { InvalidArgumentError, RunNotFoundError } from "../utils/errors.js";
import {
  FAILURES_PER_PAGE,
  renderFailureContexts,
  renderOutput,
  renderScreenshots,
  renderTests,
} from "../format/compact.js";
import { EXCERPT_RADIUS } from "./run.js";
import { READ_ONLY, envelopeSchema, errorResult, textResult } from "./result.js";

const TOOL = "cypress_get_failure";

const VIEWS = ["failures", "tests", "screenshots", "output"] as const;
type View = (typeof VIEWS)[number];

const failureDataSchema = z.object({
  view: z.enum(VIEWS),
  spec: z.string(),
  failureCount: z.number(),
  failures: z
    .array(
      z.object({
        index: z.number(),
        title: z.string(),
        fullTitle: z.string(),
        errorName: z.string().optional(),
        error: z.string(),
        location: z.string().optional(),
        diff: z.string().optional(),
        screenshot: z.string().optional(),
        excerpt: z.string().optional(),
        stack: z.string(),
      }),
    )
    .optional(),
  tests: z
    .array(
      z.object({
        title: z.string(),
        fullTitle: z.string(),
        state: z.enum(["passed", "failed", "pending", "skipped"]),
        duration: z.number(),
        attempts: z.number(),
        flaky: z.boolean(),
      }),
    )
    .optional(),
  screenshots: z.array(z.string()).optional(),
  missingScreenshots: z.number().optional(),
  stdoutTail: z.string().optional(),
  stderrTail: z.string().optional(),
  error: z.string().optional(),
  errorKind: z.enum(["compile", "timeout"]).optional(),
  runningTest: z.string().optional(),
});

type FailureData = z.infer<typeof failureDataSchema>;

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    TOOL,
    {
      title: "Inspect a Cypress run",
      description:
        'Details of a run from cypress_run. view "failures" (default): each failure with its source excerpt, full error, diff, stack and screenshot path. "tests": every test with its state. "screenshots": image paths. "output": the end of Cypress\'s stdout and stderr.',
      inputSchema: z.object({
        runId: z
          .string()
          .min(1)
          .default(LAST_RUN)
          .describe(
            'runId returned by cypress_run. "last" is the latest run of this server, which can be another agent\'s.',
          ),
        view: z.enum(VIEWS).default("failures"),
        failure: z
          .number()
          .int()
          .min(1)
          .max(100_000)
          .optional()
          .describe("Only this failure, by its number in the run result"),
      }),
      outputSchema: envelopeSchema(failureDataSchema),
      annotations: READ_ONLY,
    },
    async ({ runId, view, failure }) => {
      try {
        const record = ctx.stateStore.getRun(runId);
        if (!record) {
          throw new RunNotFoundError(runId, ctx.stateStore.runIds());
        }
        return await inspect(ctx, record, view, failure);
      } catch (err) {
        return errorResult(TOOL, err, ctx.logger);
      }
    },
  );
}

async function inspect(
  ctx: ToolContext,
  record: RunRecord,
  view: View,
  failure: number | undefined,
): Promise<CallToolResult> {
  const { result } = record;
  const base: FailureData = {
    view,
    spec: record.spec,
    failureCount: result.failures.length,
    ...(result.error ? { error: result.error } : {}),
    ...(result.errorKind ? { errorKind: result.errorKind } : {}),
    ...(result.runningTest ? { runningTest: result.runningTest } : {}),
  };
  const envelope = (summary: string, data: FailureData, nextActions: string[]) => ({
    ok: true,
    tool: TOOL,
    runId: record.runId,
    summary,
    data,
    nextActions,
  });
  const runRef = `{"runId":"${record.runId}"`;

  switch (view) {
    case "failures": {
      const all = await buildFailureContexts(record, ctx.projectRoot, EXCERPT_RADIUS);
      if (failure !== undefined && failure > all.length) {
        throw new InvalidArgumentError(
          `failure ${failure} does not exist: run ${record.runId} has ${all.length} failure(s).`,
        );
      }
      const first = failure ?? 1;
      const shown =
        failure !== undefined
          ? all.slice(failure - 1, failure)
          : all.slice(0, FAILURES_PER_PAGE);
      const nextActions: string[] = [];
      const after = first + shown.length;
      if (failure === undefined && all.length >= after) {
        nextActions.push(
          `failures ${after} to ${all.length}: cypress_get_failure ${runRef},"failure":${after}}`,
        );
      }
      if (result.error && !result.errorKind) {
        nextActions.push(
          `cypress_get_failure ${runRef},"view":"output"} for Cypress's output`,
        );
      }
      const text = renderFailureContexts(record, shown, {
        projectRoot: ctx.projectRoot,
        first,
        total: all.length,
        nextActions,
      });
      const failures = shown.map(({ stackHint: _stackHint, ...rest }) => rest);
      return textResult(
        text,
        envelope(text.split("\n", 1)[0]!, { ...base, failures }, nextActions),
      );
    }

    case "tests": {
      const text = renderTests(record, []);
      const tests = result.tests.map((test) => ({
        title: test.title,
        fullTitle: test.fullTitle,
        state: test.state,
        duration: test.duration,
        attempts: test.attempts,
        flaky: test.flaky,
      }));
      return textResult(text, envelope(text.split("\n", 1)[0]!, { ...base, tests }, []));
    }

    case "screenshots": {
      const existing: string[] = [];
      for (const file of result.screenshots) {
        try {
          await fs.access(file);
          existing.push(file);
        } catch {
          // Deleted since the run; counted below.
        }
      }
      const missing = result.screenshots.length - existing.length;
      const text = renderScreenshots(record, existing, missing, {
        projectRoot: ctx.projectRoot,
        nextActions: [],
      });
      return textResult(
        text,
        envelope(
          text.split("\n", 1)[0]!,
          {
            ...base,
            screenshots: existing,
            ...(missing > 0 ? { missingScreenshots: missing } : {}),
          },
          [],
        ),
      );
    }

    case "output": {
      const text = renderOutput(record, []);
      return textResult(
        text,
        envelope(
          text.split("\n", 1)[0]!,
          {
            ...base,
            stdoutTail: record.stdoutTail,
            stderrTail: record.stderrTail,
          },
          [],
        ),
      );
    }
  }
}

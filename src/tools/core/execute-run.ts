// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../../types/index.js";
import type { CloudRecordArgs, CypressRunArgs } from "../../types/cypress.js";
import type { CypressRunResult, FailureDetail, TestResult } from "../../types/results.js";
import type { RunRecord } from "../../services/state-store.js";
import type { RunProgress } from "../../services/reporter-events.js";
import { emptyResult, extractCloudRun } from "../../services/output-parser.js";
import { CypressMcpError, TimeoutError } from "../../utils/errors.js";
import { closestTitles } from "../../utils/closest-match.js";
import {
  buildRunNextActions,
  buildRunSummary,
  enrichRunResult,
} from "../../utils/run-results.js";

/** What the MCP SDK passes to a tool handler next to its arguments. */
export type ToolRequest = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Titles listed when run_test matched nothing; enough to pick from without flooding the context. */
const MAX_LISTED_TITLES = 100;

/** Input fields shared by every tool that starts a Cypress run. */
export const runOptionsSchema = {
  browser: z
    .string()
    .optional()
    .describe(
      "Browser name as Cypress lists it (cypress info), e.g. chrome, firefox, edge, electron, or name:channel such as chrome:beta. Paths are rejected. Omit to use the project's default browser.",
    ),
  headed: z.boolean().optional().describe("Run in headed mode (visible browser)"),
  timeout: z
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .optional()
    .describe("Timeout in ms (default: 300000)"),
  env: z
    .record(z.string().min(1), z.string())
    .optional()
    .describe(
      "Cypress env values, read in tests with cy.env() (Cypress 15.10+) or Cypress.env()",
    ),
};

/**
 * Cypress Cloud recording. The record key never appears here: Cypress reads
 * CYPRESS_RECORD_KEY from the server environment.
 */
export const cloudOptionsSchema = {
  record: z
    .boolean()
    .optional()
    .describe(
      "Record this run to Cypress Cloud (needs projectId and CYPRESS_RECORD_KEY). The result includes the Cloud run URL, which Cypress Cloud MCP tools accept.",
    ),
  tags: z
    .array(
      z
        .string()
        .min(1)
        .max(100)
        .regex(/^[^,]+$/, "Tags cannot contain commas"),
    )
    .max(20)
    .optional()
    .describe("Cloud run tags, e.g. ['local', 'agent']"),
  group: z.string().min(1).max(200).optional().describe("Cloud run group name"),
  ciBuildId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Cloud build id, to attach several recorded runs to one Cloud run"),
};

export function toCloudArgs(input: {
  record?: boolean;
  tags?: string[];
  group?: string;
  ciBuildId?: string;
}): CloudRecordArgs | undefined {
  if (!input.record) {
    return undefined;
  }
  return {
    record: true,
    tags: input.tags,
    group: input.group,
    ciBuildId: input.ciBuildId,
  };
}

interface ExecuteRunOptions {
  readonly tool: string;
  readonly kind: RunRecord["kind"];
  readonly spec: string;
  readonly args: CypressRunArgs;
  readonly testName?: string;
  readonly previousRunId?: string;
  readonly includeDiscoverOnSuccess?: boolean;
  /** The MCP request, for its abort signal and progress token */
  readonly request?: ToolRequest;
}

/** Run Cypress, record the run in session state and build the tool response. */
export async function executeRun(
  ctx: ToolContext,
  options: ExecuteRunOptions,
): Promise<CallToolResult> {
  const { tool, kind, spec, args, testName } = options;

  let raw: Awaited<ReturnType<typeof ctx.processManager.run>>;
  try {
    raw = await ctx.processManager.run(args, {
      signal: options.request?.signal,
      onProgress: progressNotifier(options.request),
    });
  } catch (err) {
    if (err instanceof TimeoutError && err.partial) {
      return recordTimedOutRun(ctx, options, err);
    }
    throw err;
  }
  const result = ctx.outputParser.parse(raw.stdout, raw.stderr, raw.exitCode);

  const screenshots = await ctx.screenshotResolver.find(spec, testName);
  const enriched = enrichRunResult(
    result,
    screenshots.length > 0 ? screenshots : result.screenshots,
  );

  const record = ctx.stateStore.recordRun(
    kind,
    spec,
    args,
    enriched,
    raw.stdout,
    raw.stderr,
  );

  // With a title filter, a run where nothing passed or failed tested nothing:
  // the filter matched no test (they all show up as pending or are omitted).
  if (
    args.grep &&
    !enriched.error &&
    enriched.stats.passing + enriched.stats.failing === 0
  ) {
    return noTestMatched(ctx, options, record.runId, enriched);
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            ok: !enriched.error,
            tool,
            runId: record.runId,
            summary: buildRunSummary(enriched, spec, testName),
            ...(options.previousRunId ? { previousRunId: options.previousRunId } : {}),
            data: enriched,
            nextActions: buildRunNextActions(enriched, {
              includeDiscoverOnSuccess: options.includeDiscoverOnSuccess,
            }),
          },
          null,
          2,
        ),
      },
    ],
  };
}

/**
 * Sends `notifications/progress` for the request when the client asked for
 * progress (gave a progressToken). Each notification carries a higher
 * progress value than the last, as the protocol requires.
 */
function progressNotifier(
  request?: ToolRequest,
): ((progress: RunProgress) => void) | undefined {
  const progressToken = request?._meta?.progressToken;
  if (!request || progressToken === undefined) {
    return undefined;
  }

  let last = -1;
  return (progress) => {
    if (progress.completed <= last) {
      return;
    }
    last = progress.completed;
    request
      .sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress: progress.completed,
          ...(progress.total === undefined ? {} : { total: progress.total }),
          message: progress.message,
        },
      })
      .catch(() => {
        // The client went away; the run itself is unaffected.
      });
  };
}

/**
 * A run killed at its timeout: keep what it did. The tests that finished,
 * their failures and the test that hung are recorded as the last run, so
 * cypress_get_last_run, cypress_get_failure_context and cypress_rerun_last
 * work on it like on any other run.
 */
async function recordTimedOutRun(
  ctx: ToolContext,
  options: ExecuteRunOptions,
  err: TimeoutError,
): Promise<CallToolResult> {
  const { tool, kind, spec, args, testName } = options;
  const partial = err.partial!;

  const tests: TestResult[] = partial.completed
    .filter((test) => !test.hook)
    .map((test) => ({
      title: test.title,
      fullTitle: test.fullTitle,
      state: test.state,
      duration: test.duration ?? 0,
      attempts: 1,
      flaky: false,
      ...(test.error ? { error: { message: test.error, stack: test.stack ?? "" } } : {}),
    }));
  const failures: FailureDetail[] = partial.completed
    .filter((test) => test.state === "failed")
    .map((test) => ({
      title: test.title,
      fullTitle: test.fullTitle,
      error: test.error ?? "Unknown error",
      stack: test.stack ?? "",
    }));
  const cloud = extractCloudRun(`${partial.stdout}\n${partial.stderr}`);

  const result: CypressRunResult = {
    ...emptyResult(),
    stats: {
      tests: tests.length,
      passing: tests.filter((test) => test.state === "passed").length,
      failing: failures.length,
      pending: tests.filter((test) => test.state === "pending").length,
      skipped: 0,
      flaky: 0,
      duration: args.timeout ?? 0,
    },
    tests,
    failures,
    error: err.message,
    errorKind: "timeout",
    ...(partial.runningTest ? { runningTest: partial.runningTest } : {}),
    stdoutTail: partial.stdout.trim().slice(-2000) || undefined,
    stderrTail: partial.stderr.trim().slice(-2000) || undefined,
    ...(cloud ? { cloud } : {}),
  };

  const screenshots = await ctx.screenshotResolver.find(spec, testName);
  const enriched = enrichRunResult(result, screenshots);
  const record = ctx.stateStore.recordRun(
    kind,
    spec,
    args,
    enriched,
    partial.stdout,
    partial.stderr,
  );

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            ok: false,
            tool,
            runId: record.runId,
            summary: buildRunSummary(enriched, spec, testName),
            ...(options.previousRunId ? { previousRunId: options.previousRunId } : {}),
            // code and suggestion as in the error envelope 0.2.1 returned for timeouts
            data: { ...err.toJSON(), ...enriched },
            nextActions: buildRunNextActions(enriched),
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

/**
 * run_test (or a rerun of it) whose title filter matched no test. 0.2.1
 * reported this as a pass. Lists the spec's real titles and the closest
 * ones so the agent can retry with a title that exists.
 */
async function noTestMatched(
  ctx: ToolContext,
  options: ExecuteRunOptions,
  runId: string,
  result: CypressRunResult,
): Promise<CallToolResult> {
  const { tool, spec, args } = options;
  const query = args.grep ?? "";
  const parsed = await ctx.specFinder.parse(spec);
  const titles = parsed?.tests.map((test) => test.fullTitle) ?? [];
  const closestMatches = closestTitles(query, titles);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            ok: false,
            tool,
            runId,
            summary: `No test matched "${query}" in ${spec}: nothing passed or failed, so nothing was tested.`,
            ...(options.previousRunId ? { previousRunId: options.previousRunId } : {}),
            data: {
              code: "NO_TEST_MATCHED",
              testName: query,
              closestMatches,
              testTitles: titles.slice(0, MAX_LISTED_TITLES),
              ...(titles.length > MAX_LISTED_TITLES
                ? { testTitleCount: titles.length }
                : {}),
              stats: result.stats,
            },
            nextActions:
              closestMatches.length > 0
                ? [
                    `cypress_run_test with testName set to one of data.closestMatches, e.g. "${closestMatches[0]}"`,
                    "cypress_run_spec to run the whole spec",
                  ]
                : [
                    "cypress_analyze_spec to see the tests in this spec",
                    "cypress_run_spec",
                  ],
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

/**
 * Next actions for errors with an obvious next step. The doctor launches
 * Cypress, so it is only the default for errors about the setup itself.
 */
const NEXT_ACTIONS_BY_CODE: Readonly<Record<string, readonly string[]>> = {
  SPEC_NOT_FOUND: ["cypress_list_specs"],
  SPEC_OUTSIDE_PROJECT: ["cypress_list_specs"],
  INVALID_ARGUMENT: ["Fix the argument as the summary says and call the tool again"],
  TITLE_FILTER_UNAVAILABLE: ["cypress_run_spec"],
  RECORD_KEY_MISSING: ["cypress_get_config"],
  CANCELLED: [],
};

/** Standard error envelope for known failures; unknown errors are rethrown. */
export function toolError(tool: string, err: unknown): CallToolResult {
  if (!(err instanceof CypressMcpError)) {
    throw err;
  }
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ok: false,
          tool,
          summary: err.message,
          data: err.toJSON(),
          nextActions: [...(NEXT_ACTIONS_BY_CODE[err.code] ?? ["cypress_doctor"])],
        }),
      },
    ],
    isError: true,
  };
}

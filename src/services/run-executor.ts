// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0
import type { ToolContext } from "../types/index.js";
import type { CypressRunArgs } from "../types/cypress.js";
import type { CypressRunResult, FailureDetail, TestResult } from "../types/results.js";
import type { RunRecord } from "./state-store.js";
import type { RunProgress } from "./reporter-events.js";
import { emptyResult, extractCloudRun } from "./output-parser.js";
import { TimeoutError } from "../utils/errors.js";
import { closestTitles } from "../utils/closest-match.js";
import { enrichRunResult } from "../utils/run-results.js";

export interface RunRequest {
  readonly kind: RunRecord["kind"];
  /** Project-relative spec path, already checked by SpecFinder.resolveSpec */
  readonly spec: string;
  readonly args: CypressRunArgs;
  /** Title filter, when the run targets one test */
  readonly testName?: string;
  /** Aborts the run: a queued run never starts, a running Cypress is killed */
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: RunProgress) => void;
}

/**
 * How a run ended. Every outcome is recorded in the state store, so the read
 * tools can inspect it by runId. Setup problems (spec not found, Cypress not
 * installed, cancelled) are thrown as CypressMcpError instead.
 */
export type RunOutcome =
  | { readonly type: "completed"; readonly record: RunRecord }
  | { readonly type: "timeout"; readonly record: RunRecord; readonly error: TimeoutError }
  | {
      readonly type: "no_match";
      readonly record: RunRecord;
      /** Full titles declared in the spec, from the static parser */
      readonly titles: readonly string[];
      readonly closestMatches: readonly string[];
    };

/** Run Cypress once and record the run. Shared by the MCP tools and the CLI. */
export async function executeCypressRun(
  ctx: ToolContext,
  request: RunRequest,
): Promise<RunOutcome> {
  const { kind, spec, args, testName } = request;

  let raw: Awaited<ReturnType<typeof ctx.processManager.run>>;
  try {
    raw = await ctx.processManager.run(args, {
      signal: request.signal,
      onProgress: request.onProgress,
    });
  } catch (err) {
    if (err instanceof TimeoutError && err.partial) {
      return {
        type: "timeout",
        record: await recordTimedOutRun(ctx, request, err),
        error: err,
      };
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
  // 0.2.1 reported this as a pass.
  if (
    args.grep &&
    !enriched.error &&
    enriched.stats.passing + enriched.stats.failing === 0
  ) {
    const parsed = await ctx.specFinder.parse(spec);
    const titles = parsed?.tests.map((test) => test.fullTitle) ?? [];
    return {
      type: "no_match",
      record,
      titles,
      closestMatches: closestTitles(args.grep, titles),
    };
  }

  return { type: "completed", record };
}

/**
 * A run killed at its timeout keeps what it did: the tests that finished,
 * their failures and the test that hung are recorded like any other run.
 */
async function recordTimedOutRun(
  ctx: ToolContext,
  request: RunRequest,
  err: TimeoutError,
): Promise<RunRecord> {
  const { kind, spec, args, testName } = request;
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
  return ctx.stateStore.recordRun(
    kind,
    spec,
    args,
    enrichRunResult(result, screenshots),
    partial.stdout,
    partial.stderr,
  );
}

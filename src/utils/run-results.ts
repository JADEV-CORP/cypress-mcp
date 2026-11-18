// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import type { CypressRunResult, FailureDetail } from "../types/results.js";

export function enrichRunResult(
  result: CypressRunResult,
  screenshots: readonly string[],
): CypressRunResult {
  const failures = attachFailureScreenshots(result.failures, screenshots);

  return {
    ...result,
    failures,
    screenshots,
  };
}

export function buildRunSummary(
  result: CypressRunResult,
  spec: string,
  testName?: string,
): string {
  if (result.errorKind === "compile") {
    return `${spec} did not compile, no test ran: see data.error`;
  }

  if (result.errorKind === "timeout") {
    const where = result.runningTest ? ` while running "${result.runningTest}"` : "";
    return `Run timed out${where} in ${spec} after ${result.stats.passing} passing, ${result.stats.failing} failing`;
  }

  if (result.error) {
    return testName
      ? `Cypress failed before executing "${testName}" in ${spec}`
      : `Cypress failed before tests executed in ${spec}`;
  }

  const flaky = result.stats.flaky > 0 ? ` (${result.stats.flaky} flaky)` : "";

  if (testName) {
    if (result.stats.tests === 0) {
      return `No tests matched "${testName}" in ${spec}`;
    }

    return result.success
      ? `Test "${testName}" passed in ${spec}${flaky}`
      : `Test "${testName}" failed in ${spec}`;
  }

  if (result.success) {
    return `All ${result.stats.passing} tests passed in ${spec}${flaky}`;
  }

  return `${result.stats.failing} failing, ${result.stats.passing} passing in ${spec}${flaky}`;
}

export function buildRunNextActions(
  result: CypressRunResult,
  options?: { includeDiscoverOnSuccess?: boolean },
): string[] {
  const actions = localNextActions(result, options);

  // A recorded run is also queryable through Cypress Cloud MCP, which adds
  // Test Replay and history across runs. Point the agent there by run URL.
  const runUrl = result.cloud?.runUrl;
  if (runUrl) {
    if (result.stats.failing > 0) {
      actions.push(
        `Cypress Cloud MCP: cypress_get_failed_tests for ${runUrl} (Test Replay links)`,
      );
    }
    if (result.stats.flaky > 0) {
      actions.push(`Cypress Cloud MCP: cypress_get_flaky_tests for ${runUrl}`);
    }
  }

  return actions;
}

function localNextActions(
  result: CypressRunResult,
  options?: { includeDiscoverOnSuccess?: boolean },
): string[] {
  if (result.error) {
    return crashNextActions(result) ?? ["cypress_doctor", "cypress_get_last_run"];
  }

  if (result.stats.failing > 0) {
    return ["cypress_get_failure_context", "cypress_get_screenshot"];
  }

  if (result.stats.flaky > 0) {
    return [
      "Stabilize the flaky test(s): data.tests entries with flaky: true",
      "cypress_rerun_last",
    ];
  }

  if (options?.includeDiscoverOnSuccess && result.stats.passing > 0) {
    return ["cypress_discover"];
  }

  return [];
}

/**
 * Next actions for a run that ended without a complete report, when the cause
 * is known. The doctor launches Cypress (about 15 s) and finds nothing wrong
 * with a project whose spec simply does not compile, so it is only suggested
 * for unexplained crashes.
 */
export function crashNextActions(result: CypressRunResult): string[] | undefined {
  if (result.errorKind === "compile") {
    return [
      "Fix the error shown in data.error (in the spec or a file it imports), then cypress_rerun_last",
    ];
  }

  if (result.errorKind === "timeout") {
    return [
      "Fix the test named in data.runningTest, or raise timeout, then cypress_rerun_last",
      "cypress_get_last_run",
    ];
  }

  return undefined;
}

function attachFailureScreenshots(
  failures: readonly FailureDetail[],
  screenshots: readonly string[],
): FailureDetail[] {
  const remaining = [...screenshots];

  return failures.map((failure) => {
    const matchIndex = remaining.findIndex((file) => matchesFailure(file, failure));
    if (matchIndex === -1) {
      return { ...failure };
    }

    const [screenshot] = remaining.splice(matchIndex, 1);
    return {
      ...failure,
      screenshot,
    };
  });
}

function matchesFailure(file: string, failure: FailureDetail): boolean {
  const fileName = sanitizeValue(path.basename(file));
  const candidates = [failure.fullTitle, failure.title]
    .map(sanitizeValue)
    .filter((value) => value.length > 0);

  return candidates.some((candidate) => fileName.includes(candidate));
}

function sanitizeValue(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

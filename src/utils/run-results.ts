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

function attachFailureScreenshots(
  failures: readonly FailureDetail[],
  screenshots: readonly string[],
): FailureDetail[] {
  const remaining = [...screenshots];

  return failures.map((failure) => {
    // Several specs can have tests with the same title: Cypress keeps each
    // spec's screenshots in a folder named after it, so look there first.
    const inSpecFolder = failure.spec
      ? remaining.findIndex(
          (file) =>
            matchesFailure(file, failure) &&
            path.basename(path.dirname(file)) === path.basename(failure.spec!),
        )
      : -1;
    const matchIndex =
      inSpecFolder !== -1
        ? inSpecFolder
        : remaining.findIndex((file) => matchesFailure(file, failure));
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

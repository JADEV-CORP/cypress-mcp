// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../types/index.js";
import type { CypressRunResult, FailureDetail } from "../../types/results.js";
import { parseSpec, type ParsedSpec } from "../../services/spec-parser.js";
import { excerptAround, findSpecLocation } from "../../utils/stack-location.js";
import { crashNextActions } from "../../utils/run-results.js";

export function register(server: McpServer, ctx: ToolContext): void {
  server.tool(
    "cypress_get_failure_context",
    "Get a compact debugging bundle for the most recent failure. Returns the failing test, error, stack hint, screenshot paths, relevant spec excerpt, and recommended next actions. This is the key tool for the fix-and-rerun loop.",
    {},
    async () => {
      const lastRun = ctx.stateStore.getLastRun();

      if (!lastRun) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                tool: "cypress_get_failure_context",
                summary: "No test run recorded. Run a spec first.",
                data: null,
                nextActions: ["cypress_run_spec", "cypress_discover"],
              }),
            },
          ],
        };
      }

      if (lastRun.result.error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  tool: "cypress_get_failure_context",
                  summary: crashSummary(lastRun.result, lastRun.spec),
                  data: {
                    runId: lastRun.runId,
                    spec: lastRun.spec,
                    error: lastRun.result.error,
                    runningTest: lastRun.result.runningTest,
                    failures:
                      lastRun.result.failures.length > 0
                        ? lastRun.result.failures
                        : undefined,
                    stdoutTail: lastRun.stdoutTail || undefined,
                    stderrTail: lastRun.stderrTail || undefined,
                  },
                  nextActions: crashNextActions(lastRun.result) ?? [
                    "cypress_doctor",
                    "cypress_get_last_run",
                    "cypress_rerun_last",
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

      if (lastRun.result.failures.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                tool: "cypress_get_failure_context",
                summary: "Last run had no failures.",
                data: { runId: lastRun.runId, spec: lastRun.spec },
                nextActions: ["cypress_discover"],
              }),
            },
          ],
        };
      }

      // Build context for each failure
      const config = await ctx.configLoader.load();
      const source = await readSpec(config.projectRoot, lastRun.spec);
      const parsed = source === undefined ? undefined : parseSpec(source);
      const failures = lastRun.result.failures.map((f) => {
        const where = locateFailure(f, lastRun.spec, parsed);
        const location = where
          ? [lastRun.spec, where.line, where.column].filter((part) => part).join(":")
          : undefined;

        return {
          testTitle: f.title,
          fullTitle: f.fullTitle,
          error: f.error,
          stackHint: extractStackHint(f.stack),
          location,
          diff: f.diff,
          screenshot: f.screenshot,
          specExcerpt:
            where && source !== undefined ? excerptAround(source, where.line) : undefined,
        };
      });

      const screenshots = await ctx.screenshotResolver.find(lastRun.spec);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                tool: "cypress_get_failure_context",
                summary: `${failures.length} failure(s) in ${lastRun.spec}`,
                data: {
                  runId: lastRun.runId,
                  spec: lastRun.spec,
                  failures,
                  screenshots,
                  stderrTail: lastRun.stderrTail || undefined,
                },
                nextActions: [
                  "Fix the failing test(s) based on the error and spec excerpt",
                  "cypress_rerun_last",
                  "cypress_get_screenshot",
                ],
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

/** Extract the most useful line from a stack trace */
function extractStackHint(stack: string): string {
  const lines = stack.split("\n").map((l) => l.trim());

  // Find the first line that points to user code (not cypress internals)
  const userLine = lines.find(
    (l) =>
      l.includes(".cy.ts") ||
      l.includes(".cy.js") ||
      l.includes("cypress/e2e") ||
      l.includes("cypress/support"),
  );

  if (userLine) return userLine;

  // Fallback: first non-empty line after the error message
  return lines.find((l) => l.startsWith("at ")) ?? lines[0] ?? "";
}

function crashSummary(result: CypressRunResult, spec: string): string {
  if (result.errorKind === "compile") {
    return `${spec} did not compile, no test ran`;
  }
  if (result.errorKind === "timeout") {
    return result.runningTest
      ? `Last run timed out in ${spec} while running "${result.runningTest}"`
      : `Last run timed out in ${spec}`;
  }
  return `Last run crashed before tests executed in ${spec}`;
}

async function readSpec(projectRoot: string, spec: string): Promise<string | undefined> {
  const absolute = path.isAbsolute(spec) ? spec : path.join(projectRoot, spec);
  try {
    return await fs.readFile(absolute, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Where in the spec a failure happened. The stack frame that points into the
 * spec is exact (Cypress maps it to the original source). Without one, for
 * example when the error comes from a support file, the test's own it() line
 * is the next best place, so every failure still gets an excerpt.
 */
function locateFailure(
  failure: FailureDetail,
  spec: string,
  parsed: ParsedSpec | undefined,
): { line: number; column?: number } | undefined {
  const fromStack = findSpecLocation(failure.stack, spec);
  if (fromStack) {
    return fromStack;
  }

  // Hook failures are titled `"before each" hook for "<test title>"`.
  const hookTarget = /hook for "(.+)"$/.exec(failure.title)?.[1];
  const declared = parsed?.tests.find(
    (test) =>
      test.fullTitle === failure.fullTitle ||
      test.name === failure.title ||
      (hookTarget !== undefined && test.name === hookTarget),
  );
  return declared ? { line: declared.line } : undefined;
}

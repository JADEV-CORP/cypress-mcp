import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { OutputParser } from "../../src/services/output-parser.js";
import {
  ReporterEventStream,
  type RunProgress,
} from "../../src/services/reporter-events.js";
import { createLogger } from "../../src/utils/logger.js";

// The reporter runs inside Cypress, so it is plain CommonJS outside src/.
const Reporter = createRequire(import.meta.url)(
  "../../reporter/cypress-mcp-reporter.cjs",
) as new (runner: EventEmitter) => unknown;

interface FakeTest {
  title: string;
  type?: string;
  duration?: number;
  err?: Record<string, unknown>;
  parent: { title: string };
  fullTitle(): string;
  currentRetry(): number;
}

function fakeTest(title: string, extra: Partial<FakeTest> = {}): FakeTest {
  return {
    title,
    duration: 12,
    parent: { title: "Checkout" },
    fullTitle: () => `Checkout ${title}`,
    currentRetry: () => 0,
    ...extra,
  };
}

/** Run the reporter on a fake Mocha runner and capture what it prints. */
function runReporter(drive: (runner: EventEmitter) => void, stats?: object): string {
  const runner = Object.assign(new EventEmitter(), {
    stats,
    suite: { total: () => 3 },
  });
  const written: string[] = [];
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });

  try {
    new Reporter(runner);
    drive(runner);
  } finally {
    write.mockRestore();
  }
  return written.join("");
}

const parser = new OutputParser(createLogger(false));

describe("cypress-mcp-reporter.cjs", () => {
  const drive = (runner: EventEmitter): void => {
    const passed = fakeTest("shows the cart page");
    const failedErr = {
      message: "expected '2' to equal '1'",
      stack:
        "AssertionError\n    at Context.eval (webpack://shop/./cypress/e2e/checkout.cy.js:5:37)",
      actual: "'2'",
      expected: "'1'",
    };
    const failed = fakeTest("adds one item", { err: failedErr });
    const skipped = fakeTest("logs in");

    runner.emit("start");
    runner.emit("test", failed);
    failed.err = failedErr;
    runner.emit("fail", failed, failedErr);
    runner.emit("test end", failed);
    runner.emit("test", passed);
    runner.emit("pass", passed);
    runner.emit("test end", passed);
    runner.emit("pending", skipped);
    runner.emit("test end", skipped);
    runner.emit("end");
  };

  it("prints a report the output parser reads like Mocha's json reporter", () => {
    const stats = {
      suites: 1,
      tests: 3,
      passes: 1,
      pending: 1,
      failures: 1,
      duration: 40,
    };
    const stream = new ReporterEventStream();
    stream.push(runReporter(drive, stats));
    const result = parser.parse(stream.end(), "", 1);

    expect(result.stats).toMatchObject({ tests: 3, passing: 1, failing: 1, pending: 1 });
    expect(result.failures[0]).toMatchObject({
      fullTitle: "Checkout adds one item",
      error: "expected '2' to equal '1'",
      diff: "Expected: '1'\nActual: '2'",
    });
    expect(result.failures[0]?.stack).toContain("checkout.cy.js:5:37");
    expect(result.tests.map((t) => [t.fullTitle, t.state])).toEqual([
      ["Checkout adds one item", "failed"],
      ["Checkout shows the cart page", "passed"],
      ["Checkout logs in", "pending"],
    ]);
  });

  it("prints one event per test while the run goes", () => {
    const progress: RunProgress[] = [];
    const stream = new ReporterEventStream((p) => progress.push(p));
    stream.push(runReporter(drive, {}));

    expect(progress).toEqual([
      { completed: 0, total: 3, message: "Cypress started, 3 tests" },
      { completed: 1, total: 3, message: "failed: Checkout adds one item" },
      { completed: 2, total: 3, message: "passed: Checkout shows the cart page" },
      { completed: 3, total: 3, message: "pending: Checkout logs in" },
    ]);
  });

  it("counts its own stats when the runner has no stats collector", () => {
    const output = runReporter(drive);
    const stream = new ReporterEventStream();
    stream.push(output);

    expect(parser.parse(stream.end(), "", 1).stats).toMatchObject({
      tests: 3,
      passing: 1,
      failing: 1,
      pending: 1,
    });
  });

  it("survives errors with circular references", () => {
    const err: Record<string, unknown> = { message: "loop" };
    err["self"] = err;
    const output = runReporter((runner) => {
      const test = fakeTest("loops", { err });
      runner.emit("fail", test, err);
      runner.emit("test end", test);
      runner.emit("end");
    }, {});

    const stream = new ReporterEventStream();
    stream.push(output);
    expect(parser.parse(stream.end(), "", 1).failures[0]?.error).toBe("loop");
  });
});

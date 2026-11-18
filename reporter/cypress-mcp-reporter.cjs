// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0
//
// Mocha reporter that cypress-mcp passes to `cypress run --reporter` in place
// of the built-in `json` reporter.
//
// While the run is going it prints one marker line per test event, so the
// server can send MCP progress notifications and, when a run times out, name
// the test that was running. At the end it prints the same JSON report as
// Mocha's `json` reporter, so results are parsed exactly as before.
//
// CommonJS with no dependencies on purpose: Cypress loads reporters with
// require() inside its own Node runtime, and older Cypress versions bundle
// Node releases that cannot require an ES module.
"use strict";

// Keep in sync with REPORTER_MARKER in src/services/reporter-events.ts.
const MARKER = "@@cypress-mcp@@";

function fullTitleOf(runnable) {
  return typeof runnable.fullTitle === "function"
    ? runnable.fullTitle()
    : String(runnable.title);
}

function currentRetryOf(test) {
  return typeof test.currentRetry === "function"
    ? test.currentRetry()
    : test.currentRetry;
}

// Same shape as Mocha's json reporter: errors become plain objects and
// circular references are replaced by their string form.
function clean(test) {
  let err = test.err || {};
  if (err instanceof Error) {
    const copy = {};
    for (const key of Object.getOwnPropertyNames(err)) {
      copy[key] = err[key];
    }
    err = copy;
  }

  return {
    title: test.title,
    fullTitle: fullTitleOf(test),
    file: test.file,
    duration: test.duration,
    currentRetry: currentRetryOf(test),
    err: cleanCycles(err),
  };
}

function cleanCycles(value) {
  const seen = [];
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (typeof item === "object" && item !== null) {
        if (seen.includes(item)) {
          return String(item);
        }
        seen.push(item);
      }
      return item;
    }),
  );
}

function emit(event) {
  // The server finds the marker anywhere in a line, so output Cypress left
  // mid-line is kept intact.
  process.stdout.write(`${MARKER}${JSON.stringify(event)}\n`);
}

function totalTests(runner) {
  try {
    if (runner.suite && typeof runner.suite.total === "function") {
      return runner.suite.total();
    }
  } catch {
    // Not every Cypress version builds a full suite tree on the server side.
  }
  return typeof runner.total === "number" ? runner.total : undefined;
}

function CypressMcpReporter(runner) {
  const tests = [];
  const pending = [];
  const failures = [];
  const passes = [];
  // Fallback when the runner has no stats collector.
  const counts = {
    suites: 0,
    tests: 0,
    passes: 0,
    pending: 0,
    failures: 0,
    start: new Date(),
  };

  runner.on("start", () => {
    counts.start = new Date();
    emit({ event: "start", total: totalTests(runner) });
  });

  runner.on("suite", (suite) => {
    if (!suite.root) counts.suites++;
  });

  runner.on("test", (test) => {
    emit({ event: "test", title: test.title, fullTitle: fullTitleOf(test) });
  });

  runner.on("test end", (test) => {
    counts.tests++;
    tests.push(test);
  });

  runner.on("pass", (test) => {
    counts.passes++;
    passes.push(test);
    emit({
      event: "pass",
      title: test.title,
      fullTitle: fullTitleOf(test),
      duration: test.duration,
    });
  });

  runner.on("fail", (test, err) => {
    counts.failures++;
    failures.push(test);
    const error = err || test.err || {};
    emit({
      event: "fail",
      // "hook" when a before/after hook failed rather than the test itself
      type: test.type,
      title: test.title,
      fullTitle: fullTitleOf(test),
      duration: test.duration,
      error: error.message,
      stack: error.stack,
    });
  });

  runner.on("pending", (test) => {
    counts.pending++;
    pending.push(test);
    emit({ event: "pending", title: test.title, fullTitle: fullTitleOf(test) });
  });

  runner.once("end", () => {
    const end = new Date();
    const stats =
      runner.stats && typeof runner.stats === "object"
        ? runner.stats
        : { ...counts, end, duration: end.getTime() - counts.start.getTime() };

    const report = {
      stats,
      tests: tests.map(clean),
      pending: pending.map(clean),
      failures: failures.map(clean),
      passes: passes.map(clean),
    };
    runner.testResults = report;
    process.stdout.write(JSON.stringify(report, null, 2));
  });
}

module.exports = CypressMcpReporter;

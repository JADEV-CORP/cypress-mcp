// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0

// Drives a real Cypress project through the built server over stdio, the same
// way an agent does. Run after `npm run build` with Cypress and @cypress/grep
// installed in test/e2e/project:  node test/e2e/smoke.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const project = fileURLToPath(new URL("./project", import.meta.url));
const server = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const spec = "cypress/e2e/math & logic.cy.js";

const env = { ...process.env };
delete env.CYPRESS_RECORD_KEY;

const client = new Client({ name: "e2e-smoke", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [server, "--cwd", project],
    env,
    stderr: "inherit",
  }),
);

async function call(name, args = {}, options = {}) {
  const res = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 600_000,
    ...options,
  });
  return { ...JSON.parse(res.content[0].text), isError: res.isError === true };
}

const checks = [];
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log(`ok  ${name}`);
}

try {
  await check("lists 12 tools", async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 12);
  });

  await check("doctor finds Cypress", async () => {
    const doctor = await call("cypress_doctor");
    const binary = doctor.data.checks.find((c) => /binary/i.test(c.check));
    assert.equal(binary?.status, "ok", JSON.stringify(doctor.data.checks));
  });

  await check("discover and list_specs count the same tests", async () => {
    const discover = await call("cypress_discover");
    const list = await call("cypress_list_specs");
    const counts = (specs) =>
      Object.fromEntries(specs.map((s) => [s.file, s.tests]).sort());
    assert.deepEqual(counts(list.specs), counts(discover.data.specs));
    assert.equal(counts(discover.data.specs)[spec], 4);
  });

  await check("run_spec reports pass, fail, flaky and env, with progress", async () => {
    const progress = [];
    const run = await call(
      "cypress_run_spec",
      { spec, env: { user: 'a,"b" & c', port: "3000" } },
      { onprogress: (p) => progress.push(p) },
    );
    // Cypress started, then one notification per test.
    assert.deepEqual(
      progress.map((p) => p.progress),
      [0, 1, 2, 3, 4],
      JSON.stringify(progress),
    );
    assert.equal(run.ok, true, run.summary);
    const { stats, tests } = run.data;
    assert.equal(stats.tests, 4, JSON.stringify(stats));
    assert.equal(stats.passing, 3, JSON.stringify(tests));
    assert.equal(stats.failing, 1, JSON.stringify(tests));
    assert.equal(stats.flaky, 1, JSON.stringify(tests));
    const flaky = tests.find((t) => t.title === "is flaky on the first attempt");
    assert.equal(flaky.attempts, 2);
  });

  await check("run_test runs only the matching test", async () => {
    const run = await call("cypress_run_test", {
      spec,
      testName: 'fails & shows "quotes"',
    });
    assert.equal(run.data.stats.failing, 1, JSON.stringify(run.data.stats));
    assert.equal(run.data.stats.passing, 0, JSON.stringify(run.data.stats));
  });

  await check("run_test with an unknown name fails with the closest titles", async () => {
    const run = await call("cypress_run_test", { spec, testName: "fails and shows quotes" });
    assert.equal(run.isError, true, run.summary);
    assert.equal(run.data.code, "NO_TEST_MATCHED");
    assert.equal(run.data.closestMatches[0], 'Math fails & shows "quotes"');
  });

  await check("failure context and rerun_last", async () => {
    await call("cypress_run_test", { spec, testName: 'fails & shows "quotes"' });
    const ctx = await call("cypress_get_failure_context");
    assert.match(JSON.stringify(ctx.data), /always wrong/);
    const [failure] = ctx.data.failures;
    // The line of the failing expect(), from the stack.
    assert.match(failure.location, /^cypress\/e2e\/math & logic\.cy\.js:12:/, failure.location);
    assert.match(failure.specExcerpt, />>> 12:\s+expect\(1, "always wrong"\)/);
    const rerun = await call("cypress_rerun_last");
    assert.ok(rerun.previousRunId, "rerun links to the previous run");
    assert.equal(rerun.data.stats.failing, 1);
  });

  await check("rejects a spec outside the project", async () => {
    const res = await call("cypress_run_spec", { spec: "../smoke.mjs" });
    assert.equal(res.data.code, "SPEC_OUTSIDE_PROJECT");
  });

  await check("record needs CYPRESS_RECORD_KEY", async () => {
    const res = await call("cypress_run_spec", { spec, record: true });
    assert.equal(res.data.code, "RECORD_KEY_MISSING");
  });

  await check("a spec that does not compile reports the cause", async () => {
    const run = await call("cypress_run_spec", { spec: "cypress/e2e/broken.cy.js" });
    assert.equal(run.data.errorKind, "compile", run.data.error);
    assert.match(run.data.error, /does-not-exist/);
    assert.ok(!run.nextActions.includes("cypress_doctor"), run.nextActions.join());
  });

  await check("browser must be a name cypress info lists", async () => {
    const asPath = await call("cypress_run_spec", {
      spec,
      browser: fileURLToPath(new URL("./smoke.mjs", import.meta.url)),
    });
    assert.equal(asPath.data.code, "INVALID_ARGUMENT", asPath.summary);
    const unknown = await call("cypress_run_spec", { spec, browser: "safari" });
    assert.equal(unknown.data.code, "INVALID_ARGUMENT", unknown.summary);
    assert.match(unknown.summary, /electron/);
  });

  await check("cancelling a run stops Cypress and frees the queue", async () => {
    const controller = new AbortController();
    const cancelled = call(
      "cypress_run_spec",
      { spec: "cypress/e2e/slow.cy.js" },
      {
        signal: controller.signal,
        // The first notification comes once Cypress runs the spec.
        onprogress: () => controller.abort("user cancelled"),
      },
    );
    await assert.rejects(cancelled);
    // Before 0.2.2 this waited for the cancelled run's 120 s cy.wait.
    const started = Date.now();
    const next = await call("cypress_run_test", { spec, testName: "adds numbers" });
    assert.equal(next.data.stats.passing, 1, next.summary);
    assert.ok(Date.now() - started < 90_000, `next run took ${Date.now() - started} ms`);
  });

  await check("a timeout keeps the partial run and names the hung test", async () => {
    let started = false;
    const run = await call(
      "cypress_run_spec",
      { spec: "cypress/e2e/slow.cy.js", timeout: 45_000 },
      { onprogress: () => (started = true) },
    );
    assert.equal(run.isError, true, run.summary);
    assert.equal(run.data.code, "TIMEOUT");
    // A slow machine may not reach the test before the timeout.
    if (started) assert.equal(run.data.runningTest, "Slow waits a long time", run.summary);
  });

  await check("get_env returns keys and types, never values", async () => {
    const envFile = path.join(project, "cypress.env.json");
    fs.writeFileSync(envFile, JSON.stringify({ adminPass: "hunter2-admin", retries: 2 }));
    try {
      const res = await call("cypress_get_env");
      assert.deepEqual(res.data.env, { adminPass: "string", retries: "number" });
      assert.doesNotMatch(JSON.stringify(res), /hunter2/);
    } finally {
      fs.rmSync(envFile, { force: true });
    }
  });
} finally {
  await client.close();
}

console.log(`\n${checks.length} e2e checks passed`);

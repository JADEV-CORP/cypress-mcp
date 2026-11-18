// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0

// Drives a real Cypress project through the built server over stdio, the same
// way an agent does, then once through the CLI. Run after `npm run build` with
// Cypress and @cypress/grep installed in test/e2e/project:
//   node test/e2e/smoke.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const project = fileURLToPath(new URL("./project", import.meta.url));
const server = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const bin = fileURLToPath(new URL("../../bin/cypress-mcp.mjs", import.meta.url));
const spec = "cypress/e2e/math & logic.cy.js";

const env = { ...process.env };
delete env.CYPRESS_RECORD_KEY;
delete env.CYPRESS_MCP_CAPS;

async function connect(args = []) {
  const client = new Client({ name: "e2e-smoke", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [server, "--cwd", project, ...args],
      env,
      stderr: "inherit",
    }),
  );
  // Listing the tools makes the client check structuredContent against each
  // tool's outputSchema on every call below.
  await client.listTools();
  return client;
}

const client = await connect(["--caps", "all"]);

async function call(name, args = {}, options = {}) {
  const res = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 600_000,
    ...options,
  });
  return {
    text: res.content[0].text,
    ...(res.structuredContent ?? JSON.parse(res.content[0].text)),
    isError: res.isError === true,
  };
}

const checks = [];
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log(`ok  ${name}`);
}

try {
  await check("lists 4 tools by default and 14 with --caps all", async () => {
    const plain = await connect();
    try {
      const { tools } = await plain.listTools();
      assert.deepEqual(
        tools.map((t) => t.name),
        ["cypress_run", "cypress_get_failure", "cypress_list_specs", "cypress_doctor"],
      );
    } finally {
      await plain.close();
    }
    const { tools } = await client.listTools();
    assert.equal(tools.length, 14);
  });

  await check("doctor finds Cypress and loads the config", async () => {
    const doctor = await call("cypress_doctor");
    const binary = doctor.data.checks.find((c) => /binary/i.test(c.check));
    assert.equal(binary?.status, "ok", doctor.text);
    const runtime = doctor.data.checks.find((c) => c.check === "Config runtime");
    assert.equal(runtime?.status, "ok", doctor.text);
  });

  await check("list_specs and the legacy discover count the same tests", async () => {
    const discover = await call("cypress_discover");
    const list = await call("cypress_list_specs");
    const counts = (specs) =>
      Object.fromEntries(specs.map((s) => [s.file, s.tests]).sort());
    assert.deepEqual(counts(list.data.specs), counts(discover.data.specs));
    assert.equal(counts(list.data.specs)[spec], 4);
  });

  let failedRun;
  await check("run reports pass, fail, flaky and env compactly, with progress", async () => {
    const progress = [];
    const run = await call(
      "cypress_run",
      { spec, env: { user: 'a,"b" & c', port: "3000" } },
      { onprogress: (p) => progress.push(p) },
    );
    // Cypress started, then one notification per test.
    assert.deepEqual(
      progress.map((p) => p.progress),
      [0, 1, 2, 3, 4],
      JSON.stringify(progress),
    );
    const { stats, tests } = run.data;
    assert.equal(stats.tests, 4, run.text);
    assert.equal(stats.passing, 3, run.text);
    assert.equal(stats.failing, 1, run.text);
    assert.equal(stats.flaky, 1, run.text);
    assert.equal(tests.find((t) => t.fullTitle === "Math is flaky on the first attempt").attempts, 2);
    const lines = run.text.split("\n");
    assert.match(lines[0], /^FAIL cypress\/e2e\/math & logic\.cy\.js: 1 failed, 3 passed, 1 flaky in /);
    assert.equal(lines[1].startsWith("screenshots") ? lines[2] : lines[1], '1) Math fails & shows "quotes"');
    assert.match(run.text, /cypress\/e2e\/math & logic\.cy\.js:12:\d+ AssertionError: always wrong/);
    assert.match(run.text, /flaky \(passed on a retry\): "Math is flaky on the first attempt" \(2 attempts\)/);
    assert.ok(run.text.length < 2_000, run.text);
    failedRun = run;
  });

  await check("get_failure shows the failing line with an excerpt", async () => {
    const ctx = await call("cypress_get_failure", { runId: failedRun.runId });
    assert.match(ctx.text, /at cypress\/e2e\/math & logic\.cy\.js:12:/);
    assert.match(ctx.text, />>> 12:\s+expect\(1, "always wrong"\)/);
    const shots = await call("cypress_get_failure", { runId: failedRun.runId, view: "screenshots" });
    assert.ok(shots.data.screenshots.length > 0, shots.text);
  });

  await check("testName runs only the matching test", async () => {
    const run = await call("cypress_run", { spec, testName: 'fails & shows "quotes"' });
    assert.equal(run.data.stats.failing, 1, run.text);
    assert.equal(run.data.stats.passing, 0, run.text);
  });

  await check("an unknown testName fails with the closest titles", async () => {
    const run = await call("cypress_run", { spec, testName: "fails and shows quotes" });
    assert.equal(run.isError, true, run.text);
    assert.equal(run.data.status, "no_match");
    assert.equal(run.data.closestMatches[0], 'Math fails & shows "quotes"');
  });

  await check("the legacy rerun_last still replays a run", async () => {
    const rerun = await call("cypress_rerun_last", { runId: failedRun.runId });
    assert.equal(rerun.previousRunId, failedRun.runId);
    assert.equal(rerun.data.stats.failing, 1);
  });

  await check("rejects a spec outside the project", async () => {
    const res = await call("cypress_run", { spec: "../smoke.mjs" });
    assert.equal(res.isError, true);
    assert.equal(res.data.code, "SPEC_OUTSIDE_PROJECT");
  });

  await check("record needs CYPRESS_RECORD_KEY", async () => {
    const res = await call("cypress_run", { spec, record: true });
    assert.equal(res.data.code, "RECORD_KEY_MISSING");
  });

  await check("a spec that does not compile reports the cause", async () => {
    const run = await call("cypress_run", { spec: "cypress/e2e/broken.cy.js" });
    assert.equal(run.isError, true);
    assert.equal(run.data.errorKind, "compile", run.text);
    assert.match(run.text, /does-not-exist/);
    assert.ok(!run.text.includes("cypress_doctor"), run.text);
  });

  await check("browser must be a name cypress info lists", async () => {
    const asPath = await call("cypress_run", {
      spec,
      browser: fileURLToPath(new URL("./smoke.mjs", import.meta.url)),
    });
    assert.equal(asPath.data.code, "INVALID_ARGUMENT", asPath.text);
    const unknown = await call("cypress_run", { spec, browser: "safari" });
    assert.equal(unknown.data.code, "INVALID_ARGUMENT", unknown.text);
    assert.match(unknown.text, /electron/);
  });

  await check("cancelling a run stops Cypress and frees the queue", async () => {
    const controller = new AbortController();
    const cancelled = call(
      "cypress_run",
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
    const next = await call("cypress_run", { spec, testName: "adds numbers" });
    assert.equal(next.data.stats.passing, 1, next.text);
    assert.ok(Date.now() - started < 90_000, `next run took ${Date.now() - started} ms`);
  });

  await check("a timeout keeps the partial run and names the hung test", async () => {
    let started = false;
    const run = await call(
      "cypress_run",
      { spec: "cypress/e2e/slow.cy.js", timeout: 45_000 },
      { onprogress: () => (started = true) },
    );
    assert.equal(run.isError, true, run.text);
    assert.equal(run.data.status, "timeout");
    // A slow machine may not reach the test before the timeout.
    if (started) assert.equal(run.data.runningTest, "Slow waits a long time", run.text);
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

await check("the CLI prints the same result and exits 1 on a failure", async () => {
  const args = ["run", spec, "--cwd", project, "--env", 'user=a,"b" & c', "--env", "port=3000"];
  const cli = spawnSync(process.execPath, [bin, ...args], {
    env,
    encoding: "utf-8",
    timeout: 600_000,
  });
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /^FAIL cypress\/e2e\/math & logic\.cy\.js: 1 failed, 3 passed, 1 flaky in /);
  assert.match(cli.stdout, /AssertionError: always wrong/);
});

console.log(`\n${checks.length} e2e checks passed`);

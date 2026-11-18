// Drives the built server through the MCP SDK client, the way an agent does,
// against a temp project whose node_modules/cypress is the fake CLI in
// test/fixtures/fake-cypress. Covers what only shows end to end: progress,
// cancellation, timeouts, the arguments passed to Cypress, and the responses
// agents read. Needs `npm run build` first, like server.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Progress } from "@modelcontextprotocol/sdk/types.js";

const SERVER_PATH = path.resolve("dist/index.js");
const PROJECT_FIXTURE = path.resolve("test/fixtures/agent-project");
const FAKE_CYPRESS = path.resolve("test/fixtures/fake-cypress");

let root: string;
let argvLog: string;
let pidFile: string;
let client: Client;

interface Envelope {
  ok: boolean;
  summary: string;
  data: Record<string, unknown>;
  nextActions: string[];
}

async function call(
  name: string,
  args: Record<string, unknown> = {},
  options: { signal?: AbortSignal; onprogress?: (p: Progress) => void } = {},
): Promise<{ isError: boolean; body: Envelope }> {
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 30_000,
    ...options,
  });
  const content = result.content as { type: string; text: string }[];
  return {
    isError: result.isError === true,
    body: JSON.parse(content[0]!.text) as Envelope,
  };
}

/** Arguments of every `cypress run` the server started, oldest first. */
function runs(): string[][] {
  if (!fs.existsSync(argvLog)) return [];
  return fs
    .readFileSync(argvLog, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
    .filter((args) => args[0] === "run");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-mcp-agent-"));
  fs.cpSync(PROJECT_FIXTURE, root, { recursive: true });
  fs.cpSync(FAKE_CYPRESS, path.join(root, "node_modules", "cypress"), {
    recursive: true,
  });
  argvLog = path.join(root, "argv.log");
  pidFile = path.join(root, "pids.json");

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "CYPRESS_RECORD_KEY") env[key] = value;
  }
  env["FAKE_CYPRESS_LOG"] = argvLog;
  env["FAKE_CYPRESS_PIDS"] = pidFile;

  client = new Client({ name: "agent-flows", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH, "--cwd", root],
      env,
      stderr: "ignore",
    }),
  );
});

afterAll(async () => {
  await client?.close();
  if (fs.existsSync(pidFile)) {
    for (const pid of JSON.parse(fs.readFileSync(pidFile, "utf-8")) as number[]) {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(argvLog, { force: true });
  fs.rmSync(pidFile, { force: true });
});

describe("cypress_run_test with a name that matches nothing (B1)", () => {
  it("fails and lists the closest real titles instead of reporting a pass", async () => {
    const { isError, body } = await call("cypress_run_test", {
      spec: "cypress/e2e/checkout.cy.js",
      testName: "logs in with valid credential",
    });
    expect(isError).toBe(false);
    expect(body.ok).toBe(true);

    const miss = await call("cypress_run_test", {
      spec: "cypress/e2e/checkout.cy.js",
      testName: "does not exist anywhere",
    });
    expect(miss.isError).toBe(true);
    expect(miss.body.ok).toBe(false);
    expect(miss.body.summary).toContain("No test matched");
    expect(miss.body.data["code"]).toBe("NO_TEST_MATCHED");
    expect(miss.body.data["testTitles"]).toEqual([
      "Checkout adds one item to the cart",
      "Checkout logs in with valid credentials",
      "Checkout shows the cart page",
    ]);
    expect((miss.body.data["closestMatches"] as string[]).length).toBeGreaterThan(0);
  });

  it("ranks a close typo first", async () => {
    const miss = await call("cypress_run_test", {
      spec: "cypress/e2e/checkout.cy.js",
      testName: "Checkout shows the kart page",
    });
    expect(miss.isError).toBe(true);
    expect((miss.body.data["closestMatches"] as string[])[0]).toBe(
      "Checkout shows the cart page",
    );
  });
});

describe("progress, cancellation and timeouts (B2)", () => {
  it("sends one progress notification per test when asked", async () => {
    const progress: Progress[] = [];
    const { body } = await call(
      "cypress_run_spec",
      { spec: "cypress/e2e/checkout.cy.js" },
      { onprogress: (p) => progress.push(p) },
    );

    expect(body.data["stats"]).toMatchObject({ tests: 3, passing: 1, failing: 2 });
    expect(progress.map((p) => p.progress)).toEqual([0, 1, 2, 3]);
    expect(progress.every((p) => p.total === 3)).toBe(true);
    expect(progress[1]?.message).toBe("failed: Checkout adds one item to the cart");
    expect(progress[3]?.message).toBe("passed: Checkout shows the cart page");
    // Event lines are consumed, never shown to the agent.
    expect(JSON.stringify(body)).not.toContain("@@cypress-mcp@@");
  });

  it("kills the whole Cypress process tree when the request is cancelled", async () => {
    const controller = new AbortController();
    const cancelled = call(
      "cypress_run_spec",
      { spec: "cypress/e2e/hang.cy.js" },
      {
        signal: controller.signal,
        onprogress: (p) => {
          if (p.progress >= 1) controller.abort("user cancelled");
        },
      },
    );

    await expect(cancelled).rejects.toThrow(/cancelled/);
    expect(await waitFor(() => fs.existsSync(pidFile), 5_000)).toBe(true);
    const pids = JSON.parse(fs.readFileSync(pidFile, "utf-8")) as number[];
    expect(await waitFor(() => pids.every((pid) => !alive(pid)), 10_000)).toBe(true);

    // The queue is free: the next run starts at once instead of waiting.
    const started = Date.now();
    const next = await call("cypress_run_spec", { spec: "cypress/e2e/pass.cy.js" });
    expect(next.body.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it("keeps the partial run and names the test that hung on timeout", async () => {
    const { isError, body } = await call("cypress_run_spec", {
      spec: "cypress/e2e/hang.cy.js",
      timeout: 2_000,
    });

    expect(isError).toBe(true);
    expect(body.data["code"]).toBe("TIMEOUT");
    expect(body.data["runningTest"]).toBe("Hang never ends");
    expect(body.summary).toContain('while running "Hang never ends"');
    expect(body.data["tests"]).toMatchObject([
      { fullTitle: "Hang finishes", state: "passed" },
    ]);

    const pids = JSON.parse(fs.readFileSync(pidFile, "utf-8")) as number[];
    expect(await waitFor(() => pids.every((pid) => !alive(pid)), 10_000)).toBe(true);

    // Recorded like any run, so the agent can inspect and replay it.
    const last = await call("cypress_get_last_run");
    expect(JSON.stringify(last.body)).toContain("Hang never ends");
  }, 30_000);
});

describe("cypress_get_failure_context (B3)", () => {
  it("marks the line from the stack and gives every failure an excerpt", async () => {
    await call("cypress_run_spec", { spec: "cypress/e2e/checkout.cy.js" });
    const { body } = await call("cypress_get_failure_context");
    const failures = body.data["failures"] as {
      location?: string;
      specExcerpt?: string;
    }[];

    expect(failures).toHaveLength(2);
    expect(failures[0]?.location).toBe("cypress/e2e/checkout.cy.js:5:37");
    expect(failures[0]?.specExcerpt).toContain(
      ">>> 5:     cy.get('[data-cy=\"cart-count\"]')",
    );
    expect(failures[1]?.location).toBe("cypress/e2e/checkout.cy.js:10:7");
    expect(failures[1]?.specExcerpt).toContain(
      ">>> 10:     cy.get('[data-cy=\"login-button\"]').click();",
    );
  });
});

describe("arguments passed to Cypress", () => {
  it("omits --browser unless the caller asks for one (B6)", async () => {
    await call("cypress_run_spec", { spec: "cypress/e2e/pass.cy.js" });
    const [args] = runs();

    expect(args).toBeDefined();
    expect(args).not.toContain("--browser");
  });

  it("passes the shipped reporter instead of the json reporter", async () => {
    await call("cypress_run_spec", { spec: "cypress/e2e/pass.cy.js" });
    const [args] = runs();
    const reporter = args![args!.indexOf("--reporter") + 1]!;

    expect(path.basename(reporter)).toBe("cypress-mcp-reporter.cjs");
    expect(path.isAbsolute(reporter)).toBe(true);
    expect(fs.existsSync(reporter)).toBe(true);
  });

  it("rejects a path as browser without starting Cypress (B8)", async () => {
    const script = path.join(root, "fakebrowser.sh");
    const { isError, body } = await call("cypress_run_spec", {
      spec: "cypress/e2e/pass.cy.js",
      browser: script,
    });

    expect(isError).toBe(true);
    expect(body.data["code"]).toBe("INVALID_ARGUMENT");
    expect(body.summary).toContain("Paths are not accepted");
    expect(runs()).toEqual([]);
  });

  it("accepts only browsers that cypress info lists (B8)", async () => {
    const unknown = await call("cypress_run_spec", {
      spec: "cypress/e2e/pass.cy.js",
      browser: "safari",
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.body.summary).toContain(
      "chrome, chrome:stable, electron, firefox, firefox:dev",
    );
    expect(runs()).toEqual([]);

    for (const browser of ["chrome", "firefox:dev", "electron"]) {
      const ok = await call("cypress_run_spec", {
        spec: "cypress/e2e/pass.cy.js",
        browser,
      });
      expect(ok.body.ok, browser).toBe(true);
    }
    expect(runs().map((args) => args[args.indexOf("--browser") + 1])).toEqual([
      "chrome",
      "firefox:dev",
      "electron",
    ]);
  });
});

describe("discovery tools agree (B5)", () => {
  it("counts the same tests in discover, list_specs and analyze_spec", async () => {
    const discover = await call("cypress_discover");
    const specs = (discover.body.data["specs"] as { file: string; tests: number }[]).sort(
      (a, b) => a.file.localeCompare(b.file),
    );
    expect(specs.map((s) => [s.file, s.tests])).toEqual([
      ["cypress/e2e/checkout.cy.js", 3],
      ["cypress/e2e/hang.cy.js", 2],
      ["cypress/e2e/pass.cy.js", 1],
    ]);

    const list = await client.callTool({ name: "cypress_list_specs", arguments: {} });
    const listed = JSON.parse((list.content as { text: string }[])[0]!.text) as {
      specs: { file: string; tests: number }[];
    };
    expect(listed.specs).toEqual(specs.map(({ file, tests }) => ({ file, tests })));

    const analyze = await client.callTool({
      name: "cypress_analyze_spec",
      arguments: { spec: "cypress/e2e/checkout.cy.js" },
    });
    const analysis = JSON.parse((analyze.content as { text: string }[])[0]!.text) as {
      structure: {
        describes: { name: string; hooks: string[]; tests: { name: string }[] }[];
      };
    };
    expect(analysis.structure.describes).toMatchObject([
      { name: "Checkout", hooks: ["beforeEach"] },
    ]);
    expect(analysis.structure.describes[0]?.tests.map((t) => t.name)).toEqual([
      "adds one item to the cart",
      "logs in with valid credentials",
      "shows the cart page",
    ]);
  });
});

describe("cypress_get_env (B7)", () => {
  it("returns keys and types, never values", async () => {
    fs.writeFileSync(
      path.join(root, "cypress.env.json"),
      JSON.stringify({
        adminPass: "hunter2-admin",
        baseUrl: "https://alice:p4ssw0rd@staging.example.com",
        retries: 2,
      }),
    );
    const result = await client.callTool({ name: "cypress_get_env", arguments: {} });
    const text = (result.content as { text: string }[])[0]!.text;

    expect(JSON.parse(text).data.env).toEqual({
      adminPass: "string",
      baseUrl: "string",
      retries: "number",
    });
    expect(text).not.toMatch(/hunter2|p4ssw0rd|alice/);

    const tools = await client.listTools();
    const description = tools.tools.find(
      (t) => t.name === "cypress_get_env",
    )?.description;
    expect(description).not.toContain("Safe to display");
  });
});

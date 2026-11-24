// Setups beyond the one-project default, through the built server and the
// fake Cypress: a monorepo root, failure context turned off, and a project
// whose config cannot load through the wrapper. Needs `npm run build` first.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER_PATH = path.resolve("dist/index.js");
const PROJECT_FIXTURE = path.resolve("test/fixtures/agent-project");
const FAKE_CYPRESS = path.resolve("test/fixtures/fake-cypress");

const roots: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  while (clients.length > 0) await clients.pop()!.close();
});

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-mcp-projects-"));
  roots.push(root);
  return root;
}

/** The agent-project fixture with the fake Cypress, at `dir`. */
function project(dir: string, serverConfig?: object): void {
  fs.cpSync(PROJECT_FIXTURE, dir, { recursive: true });
  fs.cpSync(FAKE_CYPRESS, path.join(dir, "node_modules", "cypress"), { recursive: true });
  if (serverConfig) {
    fs.writeFileSync(
      path.join(dir, "cypress-mcp.config.json"),
      JSON.stringify(serverConfig),
    );
  }
}

async function connect(root: string, env: Record<string, string> = {}): Promise<Client> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      key !== "CYPRESS_RECORD_KEY" &&
      key !== "CYPRESS_MCP_CAPS"
    ) {
      childEnv[key] = value;
    }
  }
  const client = new Client({ name: "projects", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH, "--cwd", root],
      env: { ...childEnv, ...env },
      stderr: "ignore",
    }),
  );
  await client.listTools();
  clients.push(client);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; text: string; data: Record<string, unknown> }> {
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 30_000,
  });
  const structured = result.structuredContent as { data: Record<string, unknown> };
  return {
    isError: result.isError === true,
    text: (result.content as { text: string }[])[0]!.text,
    data: structured.data,
  };
}

function runArgs(logFile: string): string[][] {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
    .filter((args) => args[0] === "run");
}

describe("monorepo root", () => {
  it("finds the project from the spec path and shows paths from the root", async () => {
    const root = tempRoot();
    project(path.join(root, "apps", "shop"));
    project(path.join(root, "apps", "admin"));
    const client = await connect(root);

    const list = await call(client, "cypress_list_specs");
    expect(list.text.split("\n")[0]).toBe(
      "12 spec(s), 18 test(s) in 2 projects (apps/admin, apps/shop)",
    );
    expect(list.text).toContain("apps/shop/cypress/e2e/checkout.cy.js: 3");

    const run = await call(client, "cypress_run", {
      spec: "apps/shop/cypress/e2e/checkout.cy.js",
    });
    expect(run.text.split("\n")[0]).toMatch(
      /^FAIL apps\/shop\/cypress\/e2e\/checkout\.cy\.js: 2 failed/,
    );
    expect(run.text).toContain(
      "   apps/shop/cypress/e2e/checkout.cy.js:10:7 AssertionError",
    );
    expect(run.data["failures"]).toMatchObject([
      { location: "apps/shop/cypress/e2e/checkout.cy.js:5:37" },
      { location: "apps/shop/cypress/e2e/checkout.cy.js:10:7" },
    ]);

    const details = await call(client, "cypress_get_failure", { failure: 2 });
    expect(details.text).toContain("at apps/shop/cypress/e2e/checkout.cy.js:10:7");
    expect(details.text).toContain(">>> 10:");

    const byProject = await call(client, "cypress_run", {
      project: "apps/admin",
      spec: "cypress/e2e/pass.cy.js",
    });
    expect(byProject.text).toMatch(/^PASS apps\/admin\/cypress\/e2e\/pass\.cy\.js/);

    const ambiguous = await call(client, "cypress_run", {
      spec: "cypress/e2e/pass.cy.js",
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.data["code"]).toBe("PROJECT_REQUIRED");
    expect(ambiguous.text).toContain("apps/admin, apps/shop");

    const doctor = await call(client, "cypress_doctor", { quick: true });
    expect(doctor.text).toContain(
      "fail Project: The server root holds several Cypress projects",
    );
    const doctorShop = await call(client, "cypress_doctor", {
      quick: true,
      project: "apps/shop",
    });
    expect(doctorShop.text).toContain("ok   Project: apps/shop");
  });
});

describe("a server root at or above the home folder", () => {
  it("is not searched for projects, and the error names it and --cwd", async () => {
    // HOME points into the temp folder, so the real home is never read.
    const root = tempRoot();
    const home = path.join(root, "home", "me");
    fs.mkdirSync(home, { recursive: true });
    project(path.join(root, "work", "shop"));
    const client = await connect(root, { HOME: home, USERPROFILE: home });

    const list = await call(client, "cypress_list_specs");
    expect(list.isError).toBe(true);
    expect(list.data["code"]).toBe("CONFIG_NOT_FOUND");
    expect(list.text).toContain(`No cypress.config.* in the server root ${root},`);
    expect(list.text).toContain("start the server with --cwd <project folder>");
    expect(list.text).not.toContain("work/shop");

    const run = await call(client, "cypress_run", {
      spec: "work/shop/cypress/e2e/pass.cy.js",
    });
    expect(run.data["code"]).toBe("CONFIG_NOT_FOUND");
    expect(run.data["suggestion"]).toContain("--cwd <project folder>");

    const doctor = await call(client, "cypress_doctor", { quick: true });
    expect(doctor.text).toContain(
      `fail Project: No cypress.config.* in the server root ${root},`,
    );
  });

  it("says when --cwd does not exist", async () => {
    const missing = path.join(tempRoot(), "no-such-folder");
    const client = await connect(missing);

    const list = await call(client, "cypress_list_specs");
    expect(list.data["code"]).toBe("CONFIG_NOT_FOUND");
    expect(list.text).toContain(
      `The server root ${missing} does not exist or is not a folder.`,
    );
  });
});

describe("failure context off", () => {
  it("runs the project's config as is, with the reporter and @cypress/grep", async () => {
    const root = tempRoot();
    project(root, { failureContext: false });
    const log = path.join(root, "argv.log");
    const client = await connect(root, { FAKE_CYPRESS_LOG: log });

    const run = await call(client, "cypress_run", {
      spec: "cypress/e2e/checkout.cy.js",
      testName: "logs in",
    });
    const [args] = runArgs(log);
    expect(args).toContain("--reporter");
    expect(args![args!.indexOf("--config-file") + 1]).toBe("cypress.config.js");
    expect(JSON.parse(args![args!.indexOf("--expose") + 1]!)).toEqual({
      grep: "logs in",
    });
    expect(run.data["contextCaptured"]).toBe(false);
    // No page lines. The error is still fenced: Cypress quotes the page in it.
    expect(run.text).not.toContain("   url: ");
    expect(run.text).toContain("<page data");

    const repeat = await call(client, "cypress_run", {
      spec: "cypress/e2e/pass.cy.js",
      repeat: 2,
    });
    expect(repeat.isError).toBe(true);
    expect(repeat.text).toContain("repeat needs failure context");

    const doctor = await call(client, "cypress_doctor", { quick: true });
    expect(doctor.text).toContain("warn Failure context: Off: failureContext is false");
  });
});

describe("a config that does not load through the wrapper", () => {
  it("reruns without it once, says so, and skips it afterwards", async () => {
    const root = tempRoot();
    project(root);
    const log = path.join(root, "argv.log");
    const client = await connect(root, {
      FAKE_CYPRESS_LOG: log,
      FAKE_WRAPPER_FAILS: "1",
    });

    const first = await call(client, "cypress_run", { spec: "cypress/e2e/pass.cy.js" });
    expect(first.isError).toBe(false);
    expect(first.text).toMatch(/^PASS cypress\/e2e\/pass\.cy\.js: 1 passed/);
    expect(first.text).toContain(
      "note: No failure context for this project: Cypress could not load cypress.config.js through the cypress-mcp wrapper",
    );
    expect(runArgs(log)).toHaveLength(2);

    fs.rmSync(log);
    const second = await call(client, "cypress_run", { spec: "cypress/e2e/pass.cy.js" });
    expect(second.text).not.toContain("note:");
    expect(runArgs(log)).toHaveLength(1);
    expect(runArgs(log)[0]).toContain("--reporter");
  });
});

describe("a cypress-mcp.config.json with a typo", () => {
  it("keeps working with defaults and shows the parse error in cypress_doctor", async () => {
    const root = tempRoot();
    project(root);
    fs.writeFileSync(
      path.join(root, "cypress-mcp.config.json"),
      '{ "failureContext": false, }\n',
    );
    // An existing binary, so the quick binary check passes on any machine.
    const client = await connect(root, { CYPRESS_RUN_BINARY: process.execPath });

    const doctor = await call(client, "cypress_doctor", { quick: true });
    expect(doctor.text.split("\n")[0]).toBe(
      "Healthy, 1 warning(s) (quick: Cypress not started)",
    );
    expect(doctor.text).toMatch(
      /^warn Server config: cypress-mcp\.config\.json ignored, defaults apply: .*JSON/m,
    );
    // failureContext: false was not applied.
    expect(doctor.text).toContain("ok   Failure context: On");
  });
});

describe("a Cypress package without its binary", () => {
  it("sends the agent to cypress install, not to the doctor", async () => {
    const root = tempRoot();
    project(root);
    const client = await connect(root, { FAKE_NO_BINARY: "1" });

    const run = await call(client, "cypress_run", { spec: "cypress/e2e/pass.cy.js" });
    expect(run.isError).toBe(true);
    expect(run.text).toContain(
      "next: npx cypress install, then run again (MCP clients may not pass CYPRESS_CACHE_FOLDER to the server, so set it in the client's env for this server if the binary lives elsewhere)",
    );
    expect(run.text).not.toContain("cypress_doctor");

    // Started, Cypress says the same: a fail, not a warning on a healthy setup.
    const doctor = await call(client, "cypress_doctor");
    expect(doctor.data["healthy"]).toBe(false);
    expect(doctor.text).toContain(
      "fail Config runtime: Cypress 16.3.0 binary not installed in",
    );
  });
});

describe("a run without spec", () => {
  it("runs every spec of the project in one launch", async () => {
    const root = tempRoot();
    project(root);
    for (const spec of ["broken", "checkout", "hang", "support"]) {
      fs.rmSync(path.join(root, "cypress", "e2e", `${spec}.cy.js`));
    }
    const log = path.join(root, "argv.log");
    const client = await connect(root, { FAKE_CYPRESS_LOG: log });

    const all = await call(client, "cypress_run");
    expect(all.isError).toBe(false);
    expect(all.text).toMatch(/^PASS 2 specs: 2 passed, 1 flaky in /);
    expect(all.data["specs"]).toEqual([
      "cypress/e2e/flaky.cy.js",
      "cypress/e2e/pass.cy.js",
    ]);
    // The project's specPattern goes to Cypress as written: one launch, a short command line.
    const [args] = runArgs(log);
    expect(args![args!.indexOf("--spec") + 1]).toBe("cypress/e2e/**/*.cy.js");

    // The specPattern read from the config is the e2e one.
    const component = await call(client, "cypress_run", { component: true });
    expect(component.isError).toBe(true);
    expect(component.data["code"]).toBe("INVALID_ARGUMENT");
    expect(runArgs(log)).toHaveLength(1);

    for (const spec of ["flaky", "pass"]) {
      fs.rmSync(path.join(root, "cypress", "e2e", `${spec}.cy.js`));
    }
    const none = await call(client, "cypress_run");
    expect(none.isError).toBe(true);
    expect(none.data["code"]).toBe("SPEC_NOT_FOUND");
    expect(none.text).toContain("cypress/e2e/**/*.cy.js");
  });

  it("names the projects of a monorepo root instead of guessing", async () => {
    const root = tempRoot();
    project(path.join(root, "apps", "shop"));
    project(path.join(root, "apps", "admin"));
    const client = await connect(root);

    const run = await call(client, "cypress_run");
    expect(run.isError).toBe(true);
    expect(run.data["code"]).toBe("PROJECT_REQUIRED");
    expect(run.text).toContain("several Cypress projects: apps/admin, apps/shop");
  });
});

// The CLI commands against the fake Cypress project, through the built bin as
// an agent's shell runs them. Needs `npm run build` first.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = path.resolve("bin/cypress-mcp.mjs");
const PROJECT_FIXTURE = path.resolve("test/fixtures/agent-project");
const FAKE_CYPRESS = path.resolve("test/fixtures/fake-cypress");

let root: string;
/** A Cypress cache holding the binary folder of the fake's version, 16.3.0 */
let cache: string;

function cli(
  args: string[],
  cwd = root,
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "CYPRESS_RECORD_KEY") env[key] = value;
  }
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...env, CYPRESS_CACHE_FOLDER: cache, ...extraEnv },
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-mcp-cli-"));
  fs.cpSync(PROJECT_FIXTURE, root, { recursive: true });
  fs.cpSync(FAKE_CYPRESS, path.join(root, "node_modules", "cypress"), {
    recursive: true,
  });
  cache = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-mcp-cache-"));
  const binary = process.platform === "darwin" ? "Cypress.app" : "Cypress";
  fs.mkdirSync(path.join(cache, "16.3.0", binary), { recursive: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(cache, { recursive: true, force: true });
});

describe("cypress-mcp run", () => {
  it("prints the compact result and exits 1 when a test fails", () => {
    const { status, stdout, stderr } = cli(["run", "cypress/e2e/checkout.cy.js"]);

    expect(status).toBe(1);
    expect(stdout).toMatch(
      /^FAIL cypress\/e2e\/checkout\.cy\.js: 2 failed, 1 passed in /,
    );
    expect(stdout).toContain("   cypress/e2e/checkout.cy.js:10:7 AssertionError:");
    // Info logs stay off stderr: an agent's shell usually shows both streams.
    expect(stderr).toBe("");
  });

  it("exits 0 when every test passes and takes --test and --cwd", () => {
    const pass = cli(["run", "cypress/e2e/pass.cy.js", "--cwd", root], os.tmpdir());
    expect(pass.status).toBe(0);
    expect(pass.stdout).toMatch(/^PASS cypress\/e2e\/pass\.cy\.js: 1 passed/);

    const one = cli([
      "run",
      "cypress/e2e/checkout.cy.js",
      "--test",
      "shows the cart page",
    ]);
    expect(one.status).toBe(0);
    expect(one.stdout).toContain('"shows the cart page": 1 passed');
  });

  it("runs several specs, a file:line and repeats in one launch", () => {
    const several = cli(["run", "cypress/e2e/pass.cy.js", "cypress/e2e/flaky.cy.js"]);
    expect(several.status).toBe(0);
    expect(several.stdout).toMatch(/^PASS 2 specs: 2 passed, 1 flaky in /);

    const atLine = cli(["run", "cypress/e2e/checkout.cy.js:13", "--repeat", "2"]);
    expect(atLine.status).toBe(0);
    expect(atLine.stdout).toMatch(
      /^PASS cypress\/e2e\/checkout\.cy\.js "Checkout shows the cart page" x2: 2 passed/,
    );

    expect(cli(["run", "cypress/e2e/pass.cy.js", "--repeat", "99"]).status).toBe(2);
  });

  it("prints the envelope with --json", () => {
    const { status, stdout } = cli(["run", "cypress/e2e/checkout.cy.js", "--json"]);
    const envelope = JSON.parse(stdout) as { tool: string; data: { status: string } };

    expect(status).toBe(1);
    expect(envelope.tool).toBe("cypress_run");
    expect(envelope.data.status).toBe("failed");
  });

  it("exits 2 on bad arguments and setup errors", () => {
    const missing = cli(["run", "cypress/e2e/nope.cy.js"]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("Error SPEC_NOT_FOUND");

    expect(cli(["run"]).status).toBe(2);
    expect(cli(["run", "a.cy.js", "--nope"]).status).toBe(2);
    expect(cli(["run", "cypress/e2e/pass.cy.js", "--timeout", "soon"]).status).toBe(2);
  });

  it("prints usage and the version", () => {
    const help = cli(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: cypress-mcp <command> [options]");
    expect(help.stdout).toContain("cypress-mcp doctor [--quick]");
    expect(help.stdout).toContain("cypress-mcp list [--titles]");

    const version = cli(["--version"]);
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8")) as {
      version: string;
    };
    expect(version.stdout.trim()).toBe(pkg.version);
  });
});

describe("cypress-mcp doctor", () => {
  it("prints the checks and exits 0 when the setup is healthy", () => {
    const quick = cli(["doctor", "--quick"]);
    expect(quick.status).toBe(0);
    expect(quick.stdout).toMatch(/^Healthy.*\(quick: Cypress not started\)\n/);
    expect(quick.stdout).toContain("ok   Config file: cypress.config.js");
    expect(quick.stderr).toBe("");

    // Without --quick it starts the (fake) Cypress once to load the config.
    const full = cli(["doctor", "--cwd", root], os.tmpdir());
    expect(full.status).toBe(0);
    expect(full.stdout).toContain("ok   Config runtime: Cypress was able to load");
  });

  it("exits 1 when a check fails and prints the envelope with --json", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-mcp-empty-"));
    try {
      const broken = cli(["doctor", "--quick", "--cwd", empty]);
      expect(broken.status).toBe(1);
      expect(broken.stdout).toContain("fail Project: No cypress.config.*");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }

    const json = cli(["doctor", "--quick", "--json"]);
    const envelope = JSON.parse(json.stdout) as {
      tool: string;
      data: { healthy: boolean; launched: boolean };
    };
    expect(envelope.tool).toBe("cypress_doctor");
    expect(envelope.data).toMatchObject({ healthy: true, launched: false });
  });

  it("exits 2 on bad arguments", () => {
    expect(cli(["doctor", "--nope"]).status).toBe(2);
    const project = cli(["doctor", "--quick", "--project", "nope"]);
    expect(project.status).toBe(2);
    expect(project.stderr).toContain("Error INVALID_ARGUMENT");
  });
});

describe("cypress-mcp list", () => {
  it("lists the specs with their test counts, and titles with --titles", () => {
    const list = cli(["list"]);
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(
      /^6 spec\(s\), \d+ test\(s\) in cypress\/e2e\/\*\*\/\*\.cy\.js\n/,
    );
    expect(list.stdout).toContain("cypress/e2e/checkout.cy.js: 3");

    const titles = cli(["list", "--titles", "--pattern", "cypress/e2e/check*.cy.js"]);
    expect(titles.status).toBe(0);
    expect(titles.stdout).toMatch(/^1 spec\(s\), 3 test\(s\)/);
    expect(titles.stdout).toContain("\n  Checkout shows the cart page");

    const json = JSON.parse(cli(["list", "--json"]).stdout) as {
      tool: string;
      data: { total: number };
    };
    expect(json.tool).toBe("cypress_list_specs");
    expect(json.data.total).toBe(6);
  });

  it("exits 2 on bad arguments and setup errors", () => {
    expect(cli(["list", "extra"]).status).toBe(2);
    const project = cli(["list", "--project", "nope"]);
    expect(project.status).toBe(2);
    expect(project.stderr).toContain("Error INVALID_ARGUMENT");
  });
});

describe("cypress-mcp with an unknown command", () => {
  it("prints the usage and exits 2 instead of starting the server", () => {
    for (const command of ["nonsense", "doctr", "lsit"]) {
      const { status, stdout, stderr } = cli([command]);
      expect(status, command).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain(`Unknown command: ${command}`);
      expect(stderr).toContain("Usage: cypress-mcp <command> [options]");
    }
  });
});

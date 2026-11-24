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

  it("runs every spec without a spec argument", () => {
    const suite = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-mcp-cli-all-"));
    try {
      fs.cpSync(root, suite, { recursive: true });
      for (const spec of ["broken", "checkout", "hang", "support"]) {
        fs.rmSync(path.join(suite, "cypress", "e2e", `${spec}.cy.js`));
      }

      const all = cli(["run"], suite);
      expect(all.status).toBe(0);
      expect(all.stdout).toMatch(/^PASS 2 specs: 2 passed, 1 flaky in /);
    } finally {
      fs.rmSync(suite, { recursive: true, force: true });
    }
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

    // A project without the cypress package: the npm package, not the binary, is missing.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-mcp-bare-"));
    try {
      fs.cpSync(PROJECT_FIXTURE, bare, { recursive: true });
      const noPackage = cli(["run", "cypress/e2e/pass.cy.js"], bare);
      expect(noPackage.status).toBe(2);
      expect(noPackage.stderr).toContain(
        "Error CYPRESS_NOT_FOUND: Cypress package not found",
      );
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }

    expect(cli(["run", "a.cy.js", "--nope"]).status).toBe(2);
    expect(cli(["run", "cypress/e2e/pass.cy.js", "--timeout", "soon"]).status).toBe(2);
  });

  it("words next steps for a shell and prints absolute screenshot paths", () => {
    const { stdout } = cli(["run", "cypress/e2e/checkout.cy.js"]);

    // A CLI process keeps no runIds, so MCP tool names would be dead ends.
    expect(stdout).not.toMatch(/cypress_\w+/);
    expect(stdout.trim().split("\n").at(-1)).toBe(
      "next: --json for source excerpts, diffs, stacks and each page outline",
    );
    // Absolute, so a terminal makes them clickable.
    const shots = [...stdout.matchAll(/^ {3}screenshot: (.+)$/gm)].map((m) => m[1]!);
    expect(shots).toHaveLength(2);
    for (const shot of shots) {
      expect(path.isAbsolute(shot), shot).toBe(true);
      expect(fs.existsSync(shot), shot).toBe(true);
    }
    expect(stdout).not.toContain("screenshots in ");

    const noMatch = cli(["run", "cypress/e2e/checkout.cy.js", "--test", "no such test"]);
    expect(noMatch.stdout).toContain(
      "next: --test with one of the titles above, or no --test for the whole spec",
    );

    const missing = cli(["run", "cypress/e2e/nope.cy.js"]);
    expect(missing.stderr).toContain("cypress-mcp list");
    expect(missing.stderr).not.toMatch(/cypress_\w+/);
  });

  it("sends a run without the Cypress binary to cypress install", () => {
    const { status, stdout } = cli(["run", "cypress/e2e/pass.cy.js"], root, {
      FAKE_NO_BINARY: "1",
    });

    expect(status).toBe(1);
    expect(stdout).toContain("No version of Cypress is installed in:");
    expect(stdout.trim().split("\n").at(-1)).toBe(
      "next: npx cypress install, then run again",
    );
  });

  it("adds source excerpts and stacks to the failures in --json", () => {
    const { stdout } = cli(["run", "cypress/e2e/checkout.cy.js", "--json"]);
    const envelope = JSON.parse(stdout) as {
      nextActions: string[];
      data: { failures: { excerpt?: string; stack?: string }[] };
    };

    expect(envelope.data.failures[1]!.excerpt).toContain(">>> 10:");
    expect(envelope.data.failures[1]!.stack).toContain("checkout.cy.js:10:7");
    expect(envelope.nextActions.join(" ")).not.toMatch(/cypress_\w+/);
  });

  it("prints usage and the version", () => {
    const help = cli(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: cypress-mcp <command> [options]");
    expect(help.stdout).toContain("cypress-mcp run [<spec>...] [options]");
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
      expect(broken.stdout).toContain(
        "next: fix the fail lines above, then run cypress-mcp doctor again",
      );
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

  it("checks the Cypress binary in the cache, or CYPRESS_RUN_BINARY, in --quick", () => {
    const binary = process.platform === "darwin" ? "Cypress.app" : "Cypress";
    expect(cli(["doctor", "--quick"]).stdout).toContain(
      `ok   Cypress binary: 16.3.0 in ${path.join(cache, "16.3.0", binary)}\n`,
    );

    // The npm package alone is not enough: Cypress runs the binary it downloads.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-mcp-cache-"));
    try {
      const missing = cli(["doctor", "--quick"], root, { CYPRESS_CACHE_FOLDER: empty });
      expect(missing.status).toBe(1);
      expect(missing.stdout).toContain(
        `fail Cypress binary: Cypress 16.3.0 binary not installed in ${path.join(empty, "16.3.0", binary)}. Run: npx cypress install. MCP clients may not pass CYPRESS_CACHE_FOLDER to the server, so set it in the client's env for this server if the binary lives elsewhere.\n`,
      );
      expect(missing.stdout).toContain("ok   Cypress package: ");

      const nowhere = path.join(root, "nowhere", "Cypress");
      const runBinary = cli(["doctor", "--quick"], root, { CYPRESS_RUN_BINARY: nowhere });
      expect(runBinary.status).toBe(1);
      expect(runBinary.stdout).toContain(
        `fail Cypress binary: CYPRESS_RUN_BINARY points at ${nowhere}, which does not exist`,
      );
      const elsewhere = path.join(root, "package.json");
      const ok = cli(["doctor", "--quick"], root, {
        CYPRESS_CACHE_FOLDER: empty,
        CYPRESS_RUN_BINARY: elsewhere,
      });
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain(`ok   Cypress binary: CYPRESS_RUN_BINARY ${elsewhere}`);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
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

// ProcessManager on the fake Cypress in test/fixtures/fake-cypress, for what
// an MCP client cannot trigger on its own: the server stopping every run
// while Cypress ignores SIGTERM. Runs from source, no build needed.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProcessManager, abortAllRuns } from "../../src/services/process-manager.js";
import { createLogger } from "../../src/utils/logger.js";

const FAKE_CYPRESS = path.resolve("test/fixtures/fake-cypress");

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

describe("abortAllRuns", () => {
  it("kills a Cypress that ignores SIGTERM after the grace period", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-mcp-abort-"));
    fs.cpSync(FAKE_CYPRESS, path.join(root, "node_modules", "cypress"), {
      recursive: true,
    });
    const pidFile = path.join(root, "pids.json");
    const previous = process.env["FAKE_CYPRESS_PIDS"];
    process.env["FAKE_CYPRESS_PIDS"] = pidFile;

    const manager = new ProcessManager(root, createLogger(false));
    const run = manager.run({ spec: "cypress/e2e/stubborn.cy.js", timeout: 60_000 });
    let pid: number | undefined;
    try {
      expect(await waitFor(() => fs.existsSync(pidFile), 5_000)).toBe(true);
      [pid] = JSON.parse(fs.readFileSync(pidFile, "utf-8")) as number[];

      await abortAllRuns();

      expect(await waitFor(() => !alive(pid!), 8_000)).toBe(true);
      // Stopped from outside the run: no timeout, no cancellation.
      await expect(run).resolves.toMatchObject({ exitCode: null });
    } finally {
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
      await run.catch(() => undefined);
      if (previous === undefined) delete process.env["FAKE_CYPRESS_PIDS"];
      else process.env["FAKE_CYPRESS_PIDS"] = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

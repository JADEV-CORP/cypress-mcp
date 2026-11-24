// ProjectRegistry on its own: which server roots it searches for Cypress
// projects, and how far. The home folder and the limits are injected, so
// nothing here reads the real disk root or home folder.
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectRegistry, type DiscoveryOptions } from "../../src/services/projects.js";
import type { ToolContext } from "../../src/types/index.js";
import { CypressMcpError } from "../../src/utils/errors.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "cypress-mcp-registry-")),
  );
  roots.push(root);
  return root;
}

function project(dir: string): void {
  fs.mkdirSync(path.join(dir, "cypress", "e2e"), { recursive: true });
  fs.writeFileSync(path.join(dir, "cypress.config.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(dir, "cypress", "e2e", "a.cy.js"), "it('a', () => {});\n");
}

function registry(root: string, options: DiscoveryOptions): ProjectRegistry {
  return new ProjectRegistry(
    root,
    (projectRoot) => ({ projectRoot }) as unknown as ToolContext,
    options,
  );
}

async function rejection(promise: Promise<unknown>): Promise<CypressMcpError> {
  const err = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(err).toBeInstanceOf(CypressMcpError);
  return err as CypressMcpError;
}

describe("a server root at or above the home folder", () => {
  it("is not searched, and the error names the root and --cwd", async () => {
    const root = tempRoot();
    const home = path.join(root, "users", "me");
    project(path.join(home, "dev", "shop"));

    for (const serverRoot of [root, path.join(root, "users"), home]) {
      const projects = registry(serverRoot, { home });
      const err = await rejection(projects.select({}));
      expect(err.code).toBe("CONFIG_NOT_FOUND");
      expect(err.message).toContain(`server root ${serverRoot}`);
      expect(err.suggestion).toContain("--cwd");
      expect((await rejection(projects.discover())).code).toBe("CONFIG_NOT_FOUND");
    }

    // Nor reached through a project or spec path from there.
    const fromHome = registry(home, { home });
    expect((await rejection(fromHome.select({ project: "dev/shop" }))).code).toBe(
      "CONFIG_NOT_FOUND",
    );
    expect(
      (await rejection(fromHome.select({ specs: ["dev/shop/cypress/e2e/a.cy.js"] })))
        .code,
    ).toBe("CONFIG_NOT_FOUND");
  });

  it("is used when it holds a cypress.config.* itself", async () => {
    const root = tempRoot();
    const home = path.join(root, "me");
    project(home);

    const selection = await registry(home, { home }).select({});
    expect(selection.prefix).toBe("");
    expect(selection.ctx.projectRoot).toBe(home);
  });

  it("does not stop the search from a folder below it", async () => {
    const root = tempRoot();
    const home = path.join(root, "me");
    project(path.join(home, "dev", "shop"));

    const projects = registry(path.join(home, "dev"), { home });
    expect((await projects.discover()).projects).toEqual(["shop"]);
    expect((await projects.select({})).prefix).toBe("shop");
  });
});

describe("a server root with no project", () => {
  it("names the root when nothing is found", async () => {
    const root = tempRoot();
    const err = await rejection(
      registry(root, { home: path.join(os.tmpdir(), "elsewhere") }).select({}),
    );
    expect(err.code).toBe("CONFIG_NOT_FOUND");
    expect(err.message).toContain(root);
  });

  it("says when the root does not exist", async () => {
    const missing = path.join(tempRoot(), "missing");
    const err = await rejection(
      registry(missing, { home: path.join(os.tmpdir(), "elsewhere") }).select({}),
    );
    expect(err.code).toBe("CONFIG_NOT_FOUND");
    expect(err.message).toBe(
      `The server root ${missing} does not exist or is not a folder.`,
    );
  });
});

describe("a large tree", () => {
  it("stops after maxFolders and says the search stopped early", async () => {
    const root = tempRoot();
    for (const name of "abcdefghij")
      fs.mkdirSync(path.join(root, name, "src"), { recursive: true });
    project(path.join(root, "web"));
    const home = path.join(os.tmpdir(), "elsewhere");

    expect(await registry(root, { home }).discover()).toEqual({ projects: ["web"] });

    const bounded = registry(root, { home, maxFolders: 5 });
    expect(await bounded.discover()).toEqual({
      projects: [],
      stoppedEarly: "after 5 folders",
    });
    const err = await rejection(bounded.select({}));
    expect(err.code).toBe("CONFIG_NOT_FOUND");
    expect(err.message).toContain(root);
    expect(err.message).toContain("stopped after 5 folders");
  });
});

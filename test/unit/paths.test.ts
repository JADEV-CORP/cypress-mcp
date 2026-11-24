import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  isBroadRoot,
  cypressBinaryDir,
  isVersionAtLeast,
  parseCwdArg,
  resolveCypressInstall,
  resolveProjectRoot,
  resolveInsideRoot,
} from "../../src/utils/paths.js";

const root = path.resolve("test/fixtures/cypress-project");

describe("resolveInsideRoot", () => {
  it("accepts paths inside the root", () => {
    expect(resolveInsideRoot(root, "cypress/e2e/sample.cy.ts")).toBe(
      path.join(root, "cypress", "e2e", "sample.cy.ts"),
    );
    expect(resolveInsideRoot(root, path.join(root, "cypress"))).toBe(
      path.join(root, "cypress"),
    );
  });

  it("accepts a folder whose name starts with two dots", () => {
    expect(resolveInsideRoot(root, "..cache/x.cy.ts")).toBe(
      path.join(root, "..cache", "x.cy.ts"),
    );
  });

  it("rejects traversal and absolute paths outside the root", () => {
    expect(resolveInsideRoot(root, "../outside.cy.ts")).toBeNull();
    expect(resolveInsideRoot(root, "cypress/../../outside.cy.ts")).toBeNull();
    expect(resolveInsideRoot(root, os.tmpdir())).toBeNull();
  });
});

describe("resolveCypressInstall", () => {
  let tmp: string;

  beforeAll(async () => {
    // realpath: on macOS the temp dir is behind a symlink (/var -> /private/var)
    // and Node's module resolution returns the real path.
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cypress-mcp-cli-")));
    // A hoisted install: cypress lives in the parent of the project
    const pkgDir = path.join(tmp, "node_modules", "cypress");
    await fs.mkdir(path.join(pkgDir, "bin"), { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "cypress",
        version: "16.0.0",
        bin: { cypress: "bin/cypress" },
      }),
    );
    await fs.writeFile(path.join(pkgDir, "bin", "cypress"), "");
    await fs.mkdir(path.join(tmp, "packages", "web"), { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("finds a Cypress install hoisted above the project", () => {
    expect(resolveCypressInstall(path.join(tmp, "packages", "web"))).toEqual({
      cli: path.join(tmp, "node_modules", "cypress", "bin", "cypress"),
      version: "16.0.0",
    });
  });

  it("returns null when Cypress is not installed", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "cypress-mcp-empty-"));
    try {
      expect(resolveCypressInstall(empty)).toBeNull();
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});

describe("isVersionAtLeast", () => {
  it("compares major and minor", () => {
    expect(isVersionAtLeast("15.10.0", 15, 10)).toBe(true);
    expect(isVersionAtLeast("16.0.0", 15, 10)).toBe(true);
    expect(isVersionAtLeast("15.9.4", 15, 10)).toBe(false);
    expect(isVersionAtLeast("14.5.4", 15, 10)).toBe(false);
  });

  it("treats an unreadable version as old", () => {
    expect(isVersionAtLeast("next", 15, 10)).toBe(false);
  });
});

describe("parseCwdArg", () => {
  it("reads --cwd <dir> and --cwd=<dir>", () => {
    expect(parseCwdArg(["--cwd", "/work/shop", "--verbose"])).toBe("/work/shop");
    expect(parseCwdArg(["--cwd=/work/my shop"])).toBe("/work/my shop");
  });

  it("returns undefined when --cwd is absent", () => {
    expect(parseCwdArg(["--verbose"])).toBeUndefined();
  });
});

describe("resolveProjectRoot", () => {
  const start = path.resolve("start-dir");
  const claude = path.resolve("claude-project");
  const flag = path.resolve("from-flag");

  it("prefers --cwd, then CLAUDE_PROJECT_DIR, then the start directory", () => {
    expect(
      resolveProjectRoot(["--cwd", flag], { CLAUDE_PROJECT_DIR: claude }, start),
    ).toBe(flag);
    expect(resolveProjectRoot([], { CLAUDE_PROJECT_DIR: claude }, start)).toBe(claude);
    expect(resolveProjectRoot([], { CLAUDE_PROJECT_DIR: " " }, start)).toBe(start);
    expect(resolveProjectRoot([], {}, start)).toBe(start);
  });
});

describe("isBroadRoot", () => {
  let tmp: string;
  let home: string;

  beforeAll(async () => {
    tmp = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "cypress-mcp-home-")),
    );
    home = path.join(tmp, "users", "me");
    await fs.mkdir(path.join(home, "dev", "shop"), { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("is true for the disk root, the home folder and the folders above it", () => {
    expect(isBroadRoot(path.parse(tmp).root, home)).toBe(true);
    expect(isBroadRoot(tmp, home)).toBe(true);
    expect(isBroadRoot(path.join(tmp, "users"), home)).toBe(true);
    expect(isBroadRoot(home, home)).toBe(true);
    expect(isBroadRoot(`${home}${path.sep}`, home)).toBe(true);
  });

  it("is false for a folder inside the home folder or beside it", () => {
    expect(isBroadRoot(path.join(home, "dev"), home)).toBe(false);
    expect(isBroadRoot(path.join(home, "dev", "shop"), home)).toBe(false);
    expect(isBroadRoot(path.join(tmp, "users", "other"), home)).toBe(false);
  });
});

describe("cypressBinaryDir", () => {
  const at = (
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv = {},
    home = "/home/dev",
  ): string => cypressBinaryDir("16.3.0", { cwd: "/work/shop", env, platform, home });

  it("looks in the platform cache, as the Cypress CLI does", () => {
    expect(at("darwin", {}, "/Users/dev")).toBe(
      "/Users/dev/Library/Caches/Cypress/16.3.0/Cypress.app",
    );
    expect(at("linux")).toBe("/home/dev/.cache/Cypress/16.3.0/Cypress");
    expect(at("linux", { XDG_CACHE_HOME: "/var/cache" })).toBe(
      "/var/cache/Cypress/16.3.0/Cypress",
    );
    expect(
      at("win32", { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" }, "C:\\Users\\dev"),
    ).toBe("C:\\Users\\dev\\AppData\\Local\\Cypress\\Cache\\16.3.0\\Cypress");
    expect(at("win32", {}, "C:\\Users\\dev")).toBe(
      "C:\\Users\\dev\\AppData\\Local\\Cypress\\Cache\\16.3.0\\Cypress",
    );
  });

  it("uses CYPRESS_CACHE_FOLDER, with ~ and paths relative to the project", () => {
    expect(at("darwin", { CYPRESS_CACHE_FOLDER: "/ci/cypress" })).toBe(
      "/ci/cypress/16.3.0/Cypress.app",
    );
    expect(at("linux", { CYPRESS_CACHE_FOLDER: "~/cy" })).toBe(
      "/home/dev/cy/16.3.0/Cypress",
    );
    expect(at("linux", { CYPRESS_CACHE_FOLDER: ".cache/cy" })).toBe(
      "/work/shop/.cache/cy/16.3.0/Cypress",
    );
  });
});

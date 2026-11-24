import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSpec } from "../../src/services/spec-parser.js";
import { SpecFinder } from "../../src/services/spec-finder.js";
import { resolveTargets, titlesAtLine } from "../../src/services/targets.js";
import { createLogger } from "../../src/utils/logger.js";
import type { ToolContext } from "../../src/types/index.js";

const SPEC = `describe("Checkout", () => {
  beforeEach(() => cy.visit("/"));
  it("adds one item", () => {
    cy.get("#add").click();
  });
  describe("when logged in", () => {
    it("shows the cart", () => {
      cy.get("#cart");
    });
    it("pays", () => {});
  });
});
`;

describe("titlesAtLine", () => {
  const parsed = parseSpec(SPEC);

  it("finds the test whose it() starts at or before the line", () => {
    expect(titlesAtLine(parsed, 3)).toEqual(["Checkout adds one item"]);
    expect(titlesAtLine(parsed, 4)).toEqual(["Checkout adds one item"]);
    expect(titlesAtLine(parsed, 8)).toEqual(["Checkout when logged in shows the cart"]);
  });

  it("gives every test of a describe at its line", () => {
    expect(titlesAtLine(parsed, 6)).toEqual([
      "Checkout when logged in shows the cart",
      "Checkout when logged in pays",
    ]);
    expect(titlesAtLine(parsed, 1)).toHaveLength(3);
  });

  it("finds nothing before the first block", () => {
    expect(titlesAtLine(parseSpec(`\n\n${SPEC}`), 1)).toEqual([]);
  });
});

describe("resolveTargets with a runtime title", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-mcp-targets-"));
  fs.mkdirSync(path.join(root, "cypress", "e2e"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "cypress", "e2e", "sizes.cy.js"),
    [
      "describe(`Cart ${size}`, () => {",
      '  it("adds", () => {});',
      "});",
      'it("works with " + N, () => {});',
      'it("static", () => {});',
    ].join("\n"),
  );
  // resolveTargets only reads the project root and the spec finder.
  const ctx = {
    projectRoot: root,
    specFinder: new SpecFinder(root, createLogger(false)),
  } as unknown as ToolContext;

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("runs the whole spec and says why when a suite above the test is dynamic", async () => {
    const targets = await resolveTargets(ctx, ["cypress/e2e/sizes.cy.js:2"]);

    expect(targets.titles).toBeUndefined();
    expect(targets.specs).toEqual(["cypress/e2e/sizes.cy.js"]);
    expect(targets.cypressSpec).toBe("cypress/e2e/sizes.cy.js");
    expect(targets.notes).toEqual([
      'cypress/e2e/sizes.cy.js:2: the title "Cart ${size} adds" is built at runtime, so no exact title can select it; ran the whole spec instead.',
    ]);
  });

  it("does the same for a test whose own title is concatenated", async () => {
    const targets = await resolveTargets(ctx, ["cypress/e2e/sizes.cy.js:4"]);

    expect(targets.titles).toBeUndefined();
    expect(targets.notes?.[0]).toContain('"${"works with " + N}"');
  });

  it("still filters a static test of the same spec", async () => {
    const targets = await resolveTargets(ctx, ["cypress/e2e/sizes.cy.js:5"]);

    expect(targets.titles).toEqual(["static"]);
    expect(targets.notes).toBeUndefined();
  });
});

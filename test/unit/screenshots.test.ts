import { describe, expect, it } from "vitest";
import path from "node:path";
import { lastAttempts } from "../../src/tools/screenshots.js";

const dir = path.join("runs", "run_1", "screenshots");
const shot = (spec: string, name: string): string => path.join(dir, spec, `${name}.png`);

describe("lastAttempts", () => {
  it("keeps the last attempt of each screenshot, in the given order", () => {
    const files = [
      shot("a.cy.js", "A -- fails (failed) (attempt 3)"),
      shot("a.cy.js", "A -- fails (failed) (attempt 2)"),
      shot("b.cy.js", "A -- fails (failed) (attempt 2)"),
      shot("a.cy.js", "A -- other (failed)"),
      shot("a.cy.js", "A -- fails (failed)"),
      shot("b.cy.js", "A -- fails (failed)"),
    ];
    expect(lastAttempts(files)).toEqual({
      last: [files[0], files[2], files[3]],
      earlier: [files[1], files[4], files[5]],
    });
  });

  it("groups the copies Cypress numbers when a name is taken", () => {
    const files = [
      shot("a.cy.js", "login (attempt 2) (1)"),
      shot("a.cy.js", "login (1)"),
      shot("a.cy.js", "login"),
    ];
    expect(lastAttempts(files)).toEqual({
      last: [files[0], files[2]],
      earlier: [files[1]],
    });
  });
});

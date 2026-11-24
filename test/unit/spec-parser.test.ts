import { describe, it, expect } from "vitest";
import { parseSpec } from "../../src/services/spec-parser.js";

const names = (source: string): string[] => parseSpec(source).tests.map((t) => t.name);

describe("parseSpec", () => {
  it("does not mistake cy.visit(...) for a test and keeps the beforeEach hook", () => {
    const spec = parseSpec(
      [
        'describe("Checkout", () => {',
        '  beforeEach(() => cy.visit("app/index.html"));',
        '  it("adds one item", () => {',
        "    cy.get('[data-cy=\"add\"]').click();",
        "  });",
        "});",
      ].join("\n"),
    );

    expect(spec.tests.map((t) => t.name)).toEqual(["adds one item"]);
    expect(spec.suites[0]?.hooks).toEqual(["beforeEach"]);
    expect(spec.tests[0]?.line).toBe(3);
  });

  it("ignores it( inside strings, comments, regexes and property calls", () => {
    const source = [
      "// it('commented out', () => {})",
      "/* it('also commented', () => {}) */",
      "const label = \"it('not a test')\";",
      "const re = /it\\('x'\\)/;",
      "cy.wrap(obj).it('not a test either');",
      "it('real one', () => {});",
    ].join("\n");

    expect(names(source)).toEqual(["real one"]);
  });

  it("reads .only, .skip and the x-prefixed forms", () => {
    const spec = parseSpec(
      [
        'describe.skip("Off", () => {',
        '  it.only("focused", () => {});',
        '  xit("parked", () => {});',
        "});",
        'context("Alias", () => { specify("works", () => {}); });',
      ].join("\n"),
    );

    expect(spec.suites.map((s) => [s.name, s.mode])).toEqual([
      ["Off", "skip"],
      ["Alias", undefined],
    ]);
    expect(spec.tests.map((t) => [t.name, t.mode])).toEqual([
      ["focused", "only"],
      ["parked", "skip"],
      ["works", undefined],
    ]);
  });

  it("keeps template literal titles as written, dynamic only with a placeholder", () => {
    const spec = parseSpec("it(`renders row ${n}`, () => {}); it(`plain`, () => {});");

    expect(spec.tests.map((t) => [t.name, t.dynamic])).toEqual([
      ["renders row ${n}", true],
      ["plain", undefined],
    ]);
  });

  it("marks a concatenated title as dynamic instead of keeping its first string", () => {
    const spec = parseSpec('it("works with " + N, () => {}); it("todo");');

    expect(spec.tests.map((t) => [t.name, t.dynamic])).toEqual([
      ['${"works with " + N}', true],
      ["todo", undefined],
    ]);
  });

  it("keeps a describe with a runtime title as a suite, so its tests keep a prefix", () => {
    const spec = parseSpec(
      [
        "describe(N, () => {",
        '  describe("Cart", () => {',
        '    it("adds", () => {});',
        "  });",
        "});",
        'it("after", () => {});',
      ].join("\n"),
    );

    expect(spec.suites.map((s) => [s.name, s.dynamic])).toEqual([
      ["${N}", true],
      ["Cart", true],
    ]);
    expect(spec.tests.map((t) => [t.fullTitle, t.dynamic])).toEqual([
      ["${N} Cart adds", true],
      ["after", undefined],
    ]);
  });

  it("handles quotes of the other kind inside titles", () => {
    expect(names(`it("doesn't break", () => {}); it('says "hi"', () => {});`)).toEqual([
      "doesn't break",
      'says "hi"',
    ]);
  });

  it("nests suites and builds Mocha-style full titles", () => {
    const spec = parseSpec(
      [
        'describe("Shop", () => {',
        '  describe("Cart", () => {',
        '    it("adds", () => {});',
        "  });",
        '  it("lists", () => {});',
        "});",
        'it("root test", () => {});',
      ].join("\n"),
    );

    expect(spec.tests.map((t) => t.fullTitle)).toEqual([
      "Shop Cart adds",
      "Shop lists",
      "root test",
    ]);
    expect(spec.root.suites).toHaveLength(1);
    expect(spec.root.suites[0]?.suites[0]?.name).toBe("Cart");
    expect(spec.root.tests.map((t) => t.name)).toEqual(["root test"]);
  });

  it("closes a suite even when its body contains parens in strings and templates", () => {
    const spec = parseSpec(
      [
        'describe("A", () => {',
        "  it(\"x\", () => { cy.log(')'); cy.log(`(${a})`); });",
        "});",
        'describe("B", () => { it("y", () => {}); });',
      ].join("\n"),
    );

    expect(spec.tests.map((t) => t.fullTitle)).toEqual(["A x", "B y"]);
  });

  it("counts tests whose title is a variable, but not calls without a callback", () => {
    expect(names("context(value); it(title, () => {}); it('static', () => {});")).toEqual(
      ["${title}", "static"],
    );
  });
});

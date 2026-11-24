// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0

// What a run should run, from the `spec` argument: one spec, several, a glob
// such as cypress/e2e/**/*.cy.ts, `file:line` to run the test (or the
// describe block) at that line, or nothing for every spec. Everything runs in
// one Cypress launch.
import { existsSync } from "node:fs";
import path from "node:path";
import type { ToolContext } from "../types/index.js";
import type { ParsedSpec, ParsedSuite, ParsedTest } from "./spec-parser.js";
import { assertPlainGlob } from "./spec-finder.js";
import { InvalidArgumentError, SpecNotFoundError } from "../utils/errors.js";

export interface RunTargets {
  /** Spec files, project relative, forward slashes */
  readonly specs: readonly string[];
  /** Value for `cypress run --spec` */
  readonly cypressSpec: string;
  /** Exact full titles, when the targets were file:line */
  readonly titles?: readonly string[];
  /** The targets were file:line, even when they fell back to whole specs */
  readonly byLine?: boolean;
  /** For the run result, such as a file:line that ran its whole spec instead */
  readonly notes?: readonly string[];
}

const GLOB_CHARS = /[*?[\]{}]/;
const FILE_LINE = /^(.+?):(\d+)(?::\d+)?$/;

/** Upper bound for one launch; a bigger suite should go through a glob in CI. */
const MAX_SPECS = 500;

/**
 * `display` turns a project relative spec path into the one the agent sees
 * (server root relative in a monorepo), for the notes.
 */
export async function resolveTargets(
  ctx: ToolContext,
  inputs: readonly string[],
  display: (spec: string) => string = (spec) => spec,
): Promise<RunTargets> {
  if (inputs.length === 0) {
    throw new InvalidArgumentError(
      "spec is required: a spec path, file:line, or a glob.",
    );
  }

  const specs: string[] = [];
  const titles: string[] = [];
  const notes: string[] = [];
  let globs = 0;
  let lineTargets = 0;
  // file:line targets whose title is built at runtime. No exact title
  // matches them, and the title filter applies to every spec of the run, so
  // one of them is enough to run whole specs.
  let dynamicTargets = 0;

  for (const raw of inputs) {
    const input = raw.trim();
    const lineMatch = FILE_LINE.exec(input);

    if (lineMatch && !existsSync(path.resolve(ctx.projectRoot, input))) {
      const spec = await ctx.specFinder.resolveSpec(lineMatch[1]!);
      const line = Number(lineMatch[2]);
      const parsed = await ctx.specFinder.parse(spec);
      const found = parsed ? testsAtLine(parsed, line) : [];
      if (found.length === 0) {
        throw new InvalidArgumentError(
          `No test or describe block starts at or before line ${line} of ${spec}. Pass the line of an it() or describe() call, or the spec alone.`,
        );
      }
      specs.push(spec);
      titles.push(...found.map((test) => test.fullTitle));
      const dynamic = found.find((test) => test.dynamic);
      if (dynamic) {
        dynamicTargets++;
        notes.push(
          `${display(spec)}:${line}: the title "${dynamic.fullTitle}" is built at runtime, so no exact title can select it; ran the whole spec instead.`,
        );
      }
      lineTargets++;
    } else if (
      GLOB_CHARS.test(input) &&
      !existsSync(path.resolve(ctx.projectRoot, input))
    ) {
      assertPlainGlob(input);
      if (path.isAbsolute(input) || input.split(/[\\/]/).includes("..")) {
        throw new InvalidArgumentError(
          `Globs must be relative to the project root and stay inside it: ${input}`,
        );
      }
      const matched = await ctx.specFinder.findSpecs(input);
      if (matched.length === 0) {
        throw new SpecNotFoundError(input);
      }
      specs.push(...matched);
      globs++;
    } else {
      specs.push(await ctx.specFinder.resolveSpec(input));
    }
  }

  if (lineTargets > 0 && lineTargets < inputs.length) {
    throw new InvalidArgumentError(
      "file:line targets cannot be mixed with whole specs or globs in one run: run them separately.",
    );
  }

  const unique = [...new Set(specs)];
  if (unique.length > MAX_SPECS) {
    throw new InvalidArgumentError(
      `${unique.length} specs match, more than ${MAX_SPECS} in one run. Narrow the glob.`,
    );
  }
  // Cypress splits --spec on commas, so a listed path cannot contain one.
  if (unique.length > 1 && unique.some((spec) => spec.includes(","))) {
    throw new InvalidArgumentError(
      "A spec path with a comma can only run on its own: Cypress splits --spec on commas.",
    );
  }

  if (dynamicTargets > 0 && lineTargets > dynamicTargets) {
    notes.push("The other file:line targets of this run ran their whole spec too.");
  }

  return {
    specs: unique,
    // A single glob goes to Cypress as written, which keeps the command line
    // short for big suites; Cypress expands it relative to the project root.
    cypressSpec:
      globs === 1 && inputs.length === 1 ? inputs[0]!.trim() : unique.join(","),
    ...(titles.length > 0 && dynamicTargets === 0
      ? { titles: [...new Set(titles)] }
      : {}),
    ...(lineTargets > 0 ? { byLine: true } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/**
 * Every spec of the project, for a run without `spec`, in one launch. The
 * specPattern goes to Cypress as written, like a glob, which keeps the
 * command line short for big suites.
 */
export async function allSpecTargets(ctx: ToolContext): Promise<RunTargets> {
  const { specPattern } = await ctx.configLoader.load();
  const specs = await ctx.specFinder.findSpecs(specPattern);
  if (specs.length === 0) {
    throw new SpecNotFoundError(specPattern.join(", "));
  }
  if (specs.length > MAX_SPECS) {
    throw new InvalidArgumentError(
      `${specs.length} specs match the project's specPattern, more than ${MAX_SPECS} in one run. Pass spec to run part of them.`,
    );
  }
  return { specs, cypressSpec: specPattern.join(",") };
}

/**
 * Full titles of the test at `line`: the innermost it() or describe() that
 * starts at or before the line. A describe gives all its tests. Exported for
 * tests.
 */
export function titlesAtLine(parsed: ParsedSpec, line: number): string[] {
  return testsAtLine(parsed, line).map((test) => test.fullTitle);
}

/** The tests behind titlesAtLine, with whether their title is built at runtime. */
function testsAtLine(parsed: ParsedSpec, line: number): ParsedTest[] {
  type Block = { line: number; tests: () => ParsedTest[] };
  const blocks: Block[] = [
    ...parsed.tests.map((test) => ({ line: test.line, tests: () => [test] })),
    ...parsed.suites.map((suite) => ({ line: suite.line, tests: () => testsIn(suite) })),
  ];
  // The latest start at or before the line; on a tie (same line), the test.
  const best = blocks
    .filter((block) => block.line > 0 && block.line <= line)
    .sort((a, b) => b.line - a.line)[0];
  return best ? best.tests() : [];
}

function testsIn(suite: ParsedSuite): ParsedTest[] {
  return [...suite.tests, ...suite.suites.flatMap(testsIn)];
}

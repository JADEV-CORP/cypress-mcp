// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0

// One static parser for describe/it blocks, shared by cypress_discover,
// cypress_analyze_spec, cypress_list_specs and cypress_run_test. Regexes over
// the raw text kept finding tests inside strings and calls such as
// cy.visit("..."), so this scans the source once and skips strings, comments
// and regex literals. It is not a JavaScript parser: a title built at runtime
// (a variable, a concatenation, a template with ${...}) cannot be known. Such a
// test or suite is still counted, marked dynamic, and shows its code as
// ${...}, so its children keep their suite prefix and nobody filters on a
// wrong literal.

import {
  readLiteral,
  scanTo,
  skipBlank,
  skipQuoted,
  skipRegex,
  startsRegex,
} from "../utils/js-scan.js";

export type BlockMode = "only" | "skip";

export interface ParsedTest {
  readonly name: string;
  /** Suite titles and the test title joined by spaces, as Mocha builds fullTitle */
  readonly fullTitle: string;
  /** 1-based line of the it() call */
  readonly line: number;
  readonly mode?: BlockMode;
  /**
   * Part of the full title is built at runtime, in this title or a suite
   * above. That part shows as `${...}`, so no exact title matches it.
   */
  readonly dynamic?: boolean;
}

export interface ParsedSuite {
  readonly name: string;
  readonly line: number;
  readonly mode?: BlockMode;
  /** The title, or a suite title above it, is built at runtime */
  readonly dynamic?: boolean;
  readonly tests: ParsedTest[];
  readonly hooks: string[];
  readonly suites: ParsedSuite[];
}

export interface ParsedSpec {
  /** Tests and hooks declared outside any describe, plus the top-level suites */
  readonly root: ParsedSuite;
  /** Every test in source order */
  readonly tests: readonly ParsedTest[];
  /** Every suite in source order, nested ones included */
  readonly suites: readonly ParsedSuite[];
}

const SUITE_CALLS = new Map<string, BlockMode | undefined>([
  ["describe", undefined],
  ["context", undefined],
  ["xdescribe", "skip"],
  ["xcontext", "skip"],
]);

const TEST_CALLS = new Map<string, BlockMode | undefined>([
  ["it", undefined],
  ["specify", undefined],
  ["xit", "skip"],
  ["xspecify", "skip"],
]);

const HOOK_CALLS = new Set(["before", "beforeEach", "after", "afterEach"]);

/** Longest code shown for a title built at runtime, so a big expression stays short. */
const MAX_TITLE_CODE = 80;

interface OpenSuite {
  readonly suite: ParsedSuite;
  /** Paren depth inside the describe( call; the suite ends when it closes */
  readonly depth: number;
}

export function parseSpec(source: string): ParsedSpec {
  const root: ParsedSuite = { name: "", line: 0, tests: [], hooks: [], suites: [] };
  const tests: ParsedTest[] = [];
  const suites: ParsedSuite[] = [];
  const open: OpenSuite[] = [];
  const scanner = new Scanner(source);

  const current = (): ParsedSuite => open.at(-1)?.suite ?? root;
  const titlePath = (): string[] => open.map((entry) => entry.suite.name);

  scanner.run({
    onIdentifier(name, start) {
      const call = readCall(source, start + name.length);
      if (!call) {
        return;
      }

      if (HOOK_CALLS.has(name) && !call.modifier) {
        const hooks = current().hooks;
        if (!hooks.includes(name)) {
          hooks.push(name);
        }
        return;
      }

      const line = scanner.lineAt(start);
      const mode = modeOf(call.modifier) ?? SUITE_CALLS.get(name) ?? TEST_CALLS.get(name);

      const dynamic = call.dynamic === true || current().dynamic === true;

      if (SUITE_CALLS.has(name) && call.title !== undefined) {
        const suite: ParsedSuite = {
          name: call.title,
          line,
          ...(mode ? { mode } : {}),
          ...(dynamic ? { dynamic } : {}),
          tests: [],
          hooks: [],
          suites: [],
        };
        current().suites.push(suite);
        suites.push(suite);
        // The scanner has not consumed the "(" yet, so the call body sits one
        // level deeper than the current depth.
        open.push({ suite, depth: scanner.depth + 1 });
        return;
      }

      if (TEST_CALLS.has(name) && call.title !== undefined) {
        const test: ParsedTest = {
          name: call.title,
          fullTitle: [...titlePath(), call.title].join(" "),
          line,
          ...(mode ? { mode } : {}),
          ...(dynamic ? { dynamic } : {}),
        };
        current().tests.push(test);
        tests.push(test);
      }
    },
    onCloseParen(depthAfter) {
      while (open.length > 0 && depthAfter < open.at(-1)!.depth) {
        open.pop();
      }
    },
  });

  return { root, tests, suites };
}

function modeOf(modifier: string | undefined): BlockMode | undefined {
  return modifier === "only" || modifier === "skip" ? modifier : undefined;
}

interface CallInfo {
  readonly modifier?: string;
  /** The title as written; code shown as `${...}` when it is built at runtime */
  readonly title?: string;
  /** The title is built at runtime */
  readonly dynamic?: boolean;
}

/**
 * Look ahead from the end of an identifier for `.only` / `.skip` and an
 * opening paren, then read the first argument. Returns undefined when the
 * identifier is not called.
 */
function readCall(source: string, from: number): CallInfo | undefined {
  let index = skipBlank(source, from);
  let modifier: string | undefined;

  if (source[index] === ".") {
    const match = /^\.\s*(only|skip)\b/.exec(source.slice(index, index + 20));
    if (!match) {
      return undefined;
    }
    modifier = match[1];
    index = skipBlank(source, index + match[0].length);
  }

  if (source[index] !== "(") {
    return undefined;
  }

  const start = skipBlank(source, index + 1);
  const literal = readLiteral(source, start);
  // A literal is the title only when it is the whole first argument:
  // it("a" + n) starts with one but is built at runtime.
  const after = literal ? source[skipBlank(source, literal.end)] : undefined;
  if (literal && (after === "," || after === ")")) {
    return {
      modifier,
      title: literal.text,
      ...(literal.dynamic ? { dynamic: true } : {}),
    };
  }

  // Any other first argument is built at runtime. Only a call with a callback
  // after it counts, so context(value) is not taken for a suite.
  const end = scanTo(source, start, ",)");
  if (end <= start || source[end] !== ",") {
    return { modifier };
  }
  return { modifier, title: runtimeTitle(source.slice(start, end)), dynamic: true };
}

/** The code of a title built at runtime, on one line, as `${code}`. */
function runtimeTitle(code: string): string {
  const flat = code.replace(/\s+/g, " ").trim();
  const shown =
    flat.length > MAX_TITLE_CODE ? `${flat.slice(0, MAX_TITLE_CODE - 3)}...` : flat;
  return "${" + shown + "}";
}

interface ScanHandlers {
  onIdentifier(name: string, start: number): void;
  onCloseParen(depthAfter: number): void;
}

/**
 * Walks the source once, tracking paren depth and line starts, and reports
 * identifiers that sit in code (not in strings, comments or regexes) and are
 * not a property access (`cy.it(` or `foo.describe(` are ignored).
 */
class Scanner {
  depth = 0;
  private readonly lineStarts: number[] = [0];

  constructor(private readonly source: string) {
    for (let i = 0; i < source.length; i++) {
      if (source[i] === "\n") {
        this.lineStarts.push(i + 1);
      }
    }
  }

  lineAt(offset: number): number {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.lineStarts[mid]! <= offset) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return low + 1;
  }

  run(handlers: ScanHandlers): void {
    const source = this.source;
    // Last significant character or word, to tell a regex from a division.
    let previous = "";
    // Open template literals; each entry counts the braces of its ${...}.
    const templates: number[] = [];
    let index = 0;

    while (index < source.length) {
      const char = source[index]!;

      if (templates.length > 0 && templates.at(-1) === 0) {
        // Inside template text, outside any ${...}
        index = this.skipTemplateText(index, templates);
        previous = "`";
        continue;
      }

      if (/\s/.test(char)) {
        index++;
        continue;
      }

      if (source.startsWith("//", index)) {
        const end = source.indexOf("\n", index);
        index = end === -1 ? source.length : end + 1;
        continue;
      }

      if (source.startsWith("/*", index)) {
        const end = source.indexOf("*/", index + 2);
        index = end === -1 ? source.length : end + 2;
        continue;
      }

      if (char === '"' || char === "'") {
        index = skipQuoted(source, index);
        previous = char;
        continue;
      }

      if (char === "`") {
        templates.push(0);
        index++;
        continue;
      }

      if (char === "/" && startsRegex(previous)) {
        index = skipRegex(source, index);
        previous = "/";
        continue;
      }

      if (templates.length > 0) {
        if (char === "{") {
          templates[templates.length - 1]!++;
        } else if (char === "}") {
          templates[templates.length - 1]!--;
          if (templates.at(-1) === 0) {
            // End of ${...}: back to template text.
            index++;
            continue;
          }
        }
      }

      if (/[A-Za-z_$]/.test(char)) {
        let end = index + 1;
        while (end < source.length && /[\w$]/.test(source[end]!)) {
          end++;
        }
        const word = source.slice(index, end);
        if (previous !== ".") {
          handlers.onIdentifier(word, index);
        }
        previous = word;
        index = end;
        continue;
      }

      if (char === "(") {
        this.depth++;
      } else if (char === ")") {
        this.depth = Math.max(0, this.depth - 1);
        handlers.onCloseParen(this.depth);
      }

      previous = char;
      index++;
    }
  }

  /** Skip template text up to the closing backtick or the next `${`. */
  private skipTemplateText(from: number, templates: number[]): number {
    const source = this.source;
    let index = from;
    while (index < source.length) {
      const char = source[index]!;
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "`") {
        templates.pop();
        return index + 1;
      }
      if (char === "$" && source[index + 1] === "{") {
        templates[templates.length - 1] = 1;
        return index + 2;
      }
      index++;
    }
    return index;
  }
}

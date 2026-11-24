// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0

// Helpers to walk JavaScript and TypeScript source without a parser: skip
// strings, templates, comments and regex literals, read one literal, find
// where an expression ends. Shared by the spec parser and the Cypress config
// reader. They cover the code found in specs and configs, not every corner of
// the language.

// After one of these characters a "/" starts a regex literal, not a division.
const REGEX_PRECEDERS = new Set("(,=:[!&|?{};+-*%<>~^");
const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of"]);

const ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r" };

/** Whether a "/" after this character or word starts a regex literal. */
export function startsRegex(previous: string): boolean {
  return previous === "" || REGEX_PRECEDERS.has(previous) || REGEX_KEYWORDS.has(previous);
}

/** Skip whitespace and comments. */
export function skipBlank(source: string, from: number): number {
  let index = from;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) {
      index++;
    } else if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end + 1;
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else {
      break;
    }
  }
  return index;
}

/** Index after the quoted string at `start`, or after the line break that cuts it. */
export function skipQuoted(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote || char === "\n") {
      return index + 1;
    }
    index++;
  }
  return index;
}

/** Index after the template literal at `start`, its `${...}` parts included. */
export function skipTemplate(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "`") {
      return index + 1;
    }
    if (char === "$" && source[index + 1] === "{") {
      const close = scanTo(source, index + 2, "}");
      if (close === -1) {
        return source.length;
      }
      index = close + 1;
      continue;
    }
    index++;
  }
  return index;
}

/** Index after the regex literal at `start` and its flags. */
export function skipRegex(source: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "\n") {
      return index;
    }
    if (inClass) {
      if (char === "]") inClass = false;
    } else if (char === "[") {
      inClass = true;
    } else if (char === "/") {
      index++;
      while (index < source.length && /[a-z]/i.test(source[index]!)) {
        index++;
      }
      return index;
    }
    index++;
  }
  return index;
}

/**
 * Index of the first character of `stops` that sits outside any bracket,
 * string, template, comment or regex opened after `start`. -1 when a bracket
 * closes that was opened before `start`, or the source ends first.
 */
export function scanTo(source: string, start: number, stops: string): number {
  let depth = 0;
  // Last significant character or word, to tell a regex from a division.
  let previous = "";
  let index = start;

  while (index < source.length) {
    const char = source[index]!;

    if (
      /\s/.test(char) ||
      source.startsWith("//", index) ||
      source.startsWith("/*", index)
    ) {
      index = skipBlank(source, index);
      continue;
    }
    if (depth === 0 && stops.includes(char)) {
      return index;
    }
    if (char === '"' || char === "'") {
      index = skipQuoted(source, index);
      previous = char;
      continue;
    }
    if (char === "`") {
      index = skipTemplate(source, index);
      previous = char;
      continue;
    }
    if (char === "/" && startsRegex(previous)) {
      index = skipRegex(source, index);
      previous = char;
      continue;
    }
    if (/[\w$]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[\w$]/.test(source[end]!)) {
        end++;
      }
      previous = source.slice(index, end);
      index = end;
      continue;
    }

    if ("([{".includes(char)) {
      depth++;
    } else if (")]}".includes(char)) {
      if (depth === 0) {
        return -1;
      }
      depth--;
    }
    previous = char;
    index++;
  }
  return -1;
}

export interface Literal {
  /** The value, escapes resolved; a template keeps its `${...}` parts as written */
  readonly text: string;
  /** Index just after the closing quote */
  readonly end: number;
  /** A template with `${...}`: its value is only known at runtime */
  readonly dynamic: boolean;
}

/**
 * Read the string or template literal that starts at `start`. Undefined when
 * there is none, or when it is not closed.
 */
export function readLiteral(source: string, start: number): Literal | undefined {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") {
    return undefined;
  }
  let text = "";
  let index = start + 1;
  let dynamic = false;

  while (index < source.length) {
    const char = source[index]!;

    if (char === "\\") {
      const next = source[index + 1] ?? "";
      text += quote === "`" ? char + next : (ESCAPES[next] ?? next);
      index += 2;
      continue;
    }
    if (char === quote) {
      return { text, end: index + 1, dynamic };
    }
    if (quote === "`" && char === "$" && source[index + 1] === "{") {
      const close = scanTo(source, index + 2, "}");
      if (close === -1) {
        return undefined;
      }
      text += source.slice(index, close + 1);
      dynamic = true;
      index = close + 1;
      continue;
    }
    if (quote !== "`" && char === "\n") {
      // Quoted strings cannot span lines: this was not a string after all.
      return undefined;
    }
    text += char;
    index++;
  }

  return undefined;
}

/**
 * The source with comments and the contents of string, template and regex
 * literals replaced by spaces, at the same offsets, line breaks kept. A regex
 * run over the mask only finds keys and brackets that are code.
 */
export function maskCode(source: string): string {
  const chars = source.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to; i++) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
  };
  let previous = "";
  let index = 0;

  while (index < source.length) {
    const char = source[index]!;

    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (source.startsWith("//", index) || source.startsWith("/*", index)) {
      const end = skipBlank(source, index);
      blank(index, end);
      index = end;
      continue;
    }

    let end = -1;
    if (char === '"' || char === "'") {
      end = skipQuoted(source, index);
    } else if (char === "`") {
      end = skipTemplate(source, index);
    } else if (char === "/" && startsRegex(previous)) {
      end = skipRegex(source, index);
    }
    if (end !== -1) {
      // Keep the delimiters, blank what is between them.
      blank(index + 1, end - 1);
      previous = char;
      index = end;
      continue;
    }

    if (/[\w$]/.test(char)) {
      let wordEnd = index + 1;
      while (wordEnd < source.length && /[\w$]/.test(source[wordEnd]!)) {
        wordEnd++;
      }
      previous = source.slice(index, wordEnd);
      index = wordEnd;
      continue;
    }
    previous = char;
    index++;
  }

  return chars.join("");
}

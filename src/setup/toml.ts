// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0

// Just enough TOML for `cypress-mcp init` to add or replace one table in a
// Codex config.toml. The package bundles its dependencies and ships none for
// TOML, so this reads the document itself. It reads the whole file, so a "["
// inside a string or a multi-line array is never taken for a table header,
// and it throws TomlSyntaxError on anything it does not know: the caller then
// refuses to edit the file instead of guessing.

export type TomlValue = string | number | boolean | RawValue | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

/** A value kept as written (dates, inf, nan, multi-line strings): never equal to one init writes. */
export class RawValue {
  constructor(readonly text: string) {}
}

export interface TomlTableHeader {
  readonly kind: "table";
  readonly path: string[];
  /** `[[...]]`, an array of tables */
  readonly array: boolean;
  /** Offsets in the text: the header line, its newline included */
  readonly start: number;
  readonly end: number;
}

export interface TomlEntry {
  readonly kind: "entry";
  /** The table the entry is in: [] before the first header */
  readonly table: string[];
  /** The key, dotted keys split */
  readonly key: string[];
  readonly value: TomlValue;
  /** Offsets in the text: from the key to the end of the line, newline included */
  readonly start: number;
  readonly end: number;
}

export type TomlStatement = TomlTableHeader | TomlEntry;

export class TomlSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${line}: ${message}`);
    this.name = "TomlSyntaxError";
  }
}

/** The table headers and key/value lines of a document, in order. */
export function parseTomlDocument(text: string): TomlStatement[] {
  return new Scanner(text).document();
}

/** A basic string. JSON escapes are valid TOML escapes; TOML also wants DEL escaped. */
export function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\u007f/g, "\\u007F");
}

export function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/** The values init writes: strings, numbers, booleans and arrays of them. */
export function tomlValue(value: unknown): string {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  throw new TypeError(`No TOML form for ${JSON.stringify(value)}`);
}

/** `[a.b]` and one `key = value` line per entry, ending with a newline. */
export function tomlTable(path: readonly string[], entries: object): string {
  const lines = [`[${path.map(tomlKey).join(".")}]`];
  for (const [key, value] of Object.entries(entries)) {
    lines.push(`${tomlKey(key)} = ${tomlValue(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

const BARE_KEY = /[A-Za-z0-9_-]+/y;
// A bare value ends at a space, a separator or a comment.
const BARE_VALUE = /[^\s,\]}#]+/y;
const NUMBER =
  /^[+-]?(?:0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?$/;
const TIME = /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
// The time after a date and a space: `1979-05-27 07:32:00Z`.
const SPACED_TIME = / \d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?/y;
const ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  e: "\u001b",
  '"': '"',
  "\\": "\\",
};

class Scanner {
  private pos = 0;

  constructor(private readonly text: string) {}

  document(): TomlStatement[] {
    const statements: TomlStatement[] = [];
    let table: string[] = [];
    for (;;) {
      this.skipBlank(true);
      if (this.pos >= this.text.length) return statements;
      const start = this.pos;
      if (this.peek() === "[") {
        const array = this.text.startsWith("[[", this.pos);
        this.pos += array ? 2 : 1;
        const path = this.key();
        this.expect(array ? "]]" : "]");
        this.lineEnd();
        statements.push({ kind: "table", path, array, start, end: this.pos });
        table = path;
      } else {
        const key = this.key();
        this.expect("=");
        const value = this.value();
        this.lineEnd();
        statements.push({ kind: "entry", table, key, value, start, end: this.pos });
      }
    }
  }

  private peek(): string | undefined {
    return this.text[this.pos];
  }

  private error(message: string): TomlSyntaxError {
    const line = this.text.slice(0, this.pos).split("\n").length;
    return new TomlSyntaxError(message, line);
  }

  private skipSpaces(): void {
    while (this.peek() === " " || this.peek() === "\t") this.pos++;
  }

  /** Spaces and comments, and newlines too when `newlines`. */
  private skipBlank(newlines: boolean): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t" || (newlines && (c === "\n" || c === "\r"))) {
        this.pos++;
      } else if (c === "#") {
        while (this.pos < this.text.length && this.peek() !== "\n") this.pos++;
      } else {
        return;
      }
    }
  }

  private expect(token: string): void {
    this.skipSpaces();
    if (!this.text.startsWith(token, this.pos)) throw this.error(`expected ${token}`);
    this.pos += token.length;
  }

  /** Spaces, a comment, then the newline (consumed) or the end of the text. */
  private lineEnd(): void {
    this.skipBlank(false);
    if (this.pos >= this.text.length) return;
    if (this.peek() === "\n") {
      this.pos++;
    } else if (this.text.startsWith("\r\n", this.pos)) {
      this.pos += 2;
    } else {
      throw this.error(
        `unexpected ${JSON.stringify(this.text.slice(this.pos, this.pos + 20))}`,
      );
    }
  }

  private key(): string[] {
    const parts: string[] = [];
    for (;;) {
      this.skipSpaces();
      parts.push(this.keyPart());
      this.skipSpaces();
      if (this.peek() !== ".") return parts;
      this.pos++;
    }
  }

  private keyPart(): string {
    if (this.peek() === '"') return this.basicString();
    if (this.peek() === "'") return this.literalString();
    BARE_KEY.lastIndex = this.pos;
    const match = BARE_KEY.exec(this.text);
    if (!match) throw this.error("expected a key");
    this.pos += match[0].length;
    return match[0];
  }

  private value(): TomlValue {
    this.skipSpaces();
    if (this.text.startsWith('"""', this.pos)) return this.multiline('"""');
    if (this.text.startsWith("'''", this.pos)) return this.multiline("'''");
    switch (this.peek()) {
      case '"':
        return this.basicString();
      case "'":
        return this.literalString();
      case "[":
        return this.array();
      case "{":
        return this.inlineTable();
      default:
        return this.scalar();
    }
  }

  private basicString(): string {
    this.pos++;
    let out = "";
    for (;;) {
      const c = this.peek();
      if (c === undefined || c === "\n") throw this.error("unterminated string");
      this.pos++;
      if (c === '"') return out;
      if (c !== "\\") {
        out += c;
        continue;
      }
      const escape = this.peek() ?? "";
      this.pos++;
      const decoded = Object.hasOwn(ESCAPES, escape) ? ESCAPES[escape] : undefined;
      if (decoded !== undefined) {
        out += decoded;
      } else if (escape === "u" || escape === "U") {
        const length = escape === "u" ? 4 : 8;
        const hex = this.text.slice(this.pos, this.pos + length);
        if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== length) {
          throw this.error(`bad escape \\${escape}${hex}`);
        }
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        this.pos += length;
      } else {
        throw this.error(`bad escape \\${escape}`);
      }
    }
  }

  private literalString(): string {
    const end = this.text.indexOf("'", this.pos + 1);
    const newline = this.text.indexOf("\n", this.pos + 1);
    if (end === -1 || (newline !== -1 && newline < end)) {
      throw this.error("unterminated string");
    }
    const value = this.text.slice(this.pos + 1, end);
    this.pos = end + 1;
    return value;
  }

  /** Skipped, not decoded: init never compares a value of its own with one. */
  private multiline(delimiter: '"""' | "'''"): RawValue {
    const start = this.pos;
    this.pos += 3;
    for (;;) {
      if (this.pos >= this.text.length) throw this.error("unterminated string");
      if (delimiter === '"""' && this.peek() === "\\") {
        this.pos += 2;
      } else if (this.text.startsWith(delimiter, this.pos)) {
        this.pos += 3;
        // Up to two quotes may sit just before the closing delimiter.
        for (let extra = 0; extra < 2 && this.peek() === delimiter[0]; extra++)
          this.pos++;
        return new RawValue(this.text.slice(start, this.pos));
      } else {
        this.pos++;
      }
    }
  }

  private array(): TomlValue[] {
    this.pos++;
    const items: TomlValue[] = [];
    for (;;) {
      this.skipBlank(true);
      if (this.peek() === "]") {
        this.pos++;
        return items;
      }
      items.push(this.value());
      this.skipBlank(true);
      if (this.peek() === ",") {
        this.pos++;
      } else if (this.peek() !== "]") {
        throw this.error("expected , or ] in an array");
      }
    }
  }

  private inlineTable(): TomlTable {
    this.pos++;
    // No prototype, so a "__proto__" key is a plain key.
    const table = Object.create(null) as TomlTable;
    for (;;) {
      // Newlines are TOML 1.1, which Codex may accept: reading them costs nothing.
      this.skipBlank(true);
      if (this.peek() === "}") {
        this.pos++;
        return table;
      }
      const key = this.key();
      this.expect("=");
      if (!setPath(table, key, this.value())) {
        throw this.error(`${key.join(".")} is defined twice`);
      }
      this.skipBlank(true);
      if (this.peek() === ",") {
        this.pos++;
      } else if (this.peek() !== "}") {
        throw this.error("expected , or } in an inline table");
      }
    }
  }

  private scalar(): TomlValue {
    BARE_VALUE.lastIndex = this.pos;
    const match = BARE_VALUE.exec(this.text);
    if (!match) throw this.error("expected a value");
    let token = match[0];
    this.pos += token.length;
    if (token === "true" || token === "false") return token === "true";
    if (NUMBER.test(token)) {
      const number = Number(token.replace(/_/g, ""));
      return Number.isNaN(number) ? new RawValue(token) : number;
    }
    if (DATE.test(token)) {
      SPACED_TIME.lastIndex = this.pos;
      const time = SPACED_TIME.exec(this.text);
      if (time) {
        token += time[0];
        this.pos += time[0].length;
      }
      return new RawValue(token);
    }
    if (DATE_TIME.test(token) || TIME.test(token) || /^[+-]?(?:inf|nan)$/.test(token)) {
      return new RawValue(token);
    }
    throw this.error(`cannot read the value ${token}`);
  }
}

/** Sets a dotted key in an inline table; false when the key is already taken. */
function setPath(table: TomlTable, key: readonly string[], value: TomlValue): boolean {
  let current = table;
  for (const part of key.slice(0, -1)) {
    const next = current[part];
    if (next === undefined) {
      const created = Object.create(null) as TomlTable;
      current[part] = created;
      current = created;
    } else if (isTable(next)) {
      current = next;
    } else {
      return false;
    }
  }
  const last = key[key.length - 1]!;
  if (last in current) return false;
  current[last] = value;
  return true;
}

function isTable(value: TomlValue): value is TomlTable {
  return (
    typeof value === "object" && !Array.isArray(value) && !(value instanceof RawValue)
  );
}

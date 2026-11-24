// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0

// Puts the cypress entry into a client config that may already hold other
// servers and settings. The rules are the same for JSON and TOML:
// - everything outside the cypress entry is kept;
// - an entry with the same values for the keys init writes is left alone,
//   whatever else it has (env, disabled...);
// - an entry that differs is only replaced with --force, keeping env;
// - a file init cannot rewrite without losing something (JSON with comments,
//   TOML it cannot read) is refused, and the caller prints the entry to add
//   by hand.
import { parseTomlDocument, tomlTable, RawValue, TomlSyntaxError } from "./toml.js";
import type { TomlEntry, TomlStatement, TomlTableHeader } from "./toml.js";

export const SERVER_NAME = "cypress";

/** A server entry as init writes it: strings, numbers and string arrays. */
export type ServerEntry = Readonly<Record<string, string | number | readonly string[]>>;

/**
 * create: the file does not exist; update: the entry is added or replaced;
 * unchanged: it is already there; differs: it is there with other values and
 * --force was not given; refused: the file cannot be edited safely.
 */
export type MergeStatus = "create" | "update" | "unchanged" | "differs" | "refused";

export interface MergeResult {
  readonly status: MergeStatus;
  /** The new content of the file, for create and update */
  readonly text?: string;
  /** For update: true when an existing entry was replaced */
  readonly replaced?: boolean;
  /** Other servers in the file */
  readonly otherServers?: number;
  /** For differs: one line per key whose value is not the one init writes */
  readonly differences?: string[];
  /** For refused */
  readonly reason?: string;
}

/**
 * Keys --force keeps from the entry it replaces. The README sends
 * CYPRESS_RECORD_KEY, CYPRESS_CACHE_FOLDER and proxy settings there.
 */
const KEPT_KEYS: ReadonlySet<string> = new Set(["env", "envFile", "env_vars"]);

/**
 * The file with the entry under `container` (mcpServers, servers), written
 * with 2-space indent and a trailing newline. CRLF files stay CRLF.
 */
export function mergeJson(
  existing: string | undefined,
  container: string,
  entry: ServerEntry,
  force: boolean,
): MergeResult {
  if (existing === undefined) {
    return {
      status: "create",
      text: jsonText({ [container]: { [SERVER_NAME]: entry } }, "\n"),
      replaced: false,
      otherServers: 0,
    };
  }

  const source = existing.replace(/^﻿/, "");
  let data: unknown;
  try {
    data = source.trim() === "" ? {} : JSON.parse(source);
  } catch (err) {
    // Rewriting a JSONC file would drop its comments.
    return refused(
      `it is not plain JSON (${err instanceof Error ? err.message : String(err)}); init does not rewrite files with comments or trailing commas`,
    );
  }
  if (!isObject(data)) return refused("its top level is not a JSON object");

  if (!Object.hasOwn(data, container)) data[container] = {};
  const servers = data[container];
  if (!isObject(servers)) return refused(`"${container}" is not an object`);

  const otherServers = Object.keys(servers).filter((name) => name !== SERVER_NAME).length;
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  if (!Object.hasOwn(servers, SERVER_NAME)) {
    servers[SERVER_NAME] = entry;
    return { status: "update", text: jsonText(data, eol), replaced: false, otherServers };
  }

  const current = servers[SERVER_NAME];
  const differences = isObject(current)
    ? differencesFrom(current, entry)
    : [`${SERVER_NAME} is ${JSON.stringify(current)}, not an object`];
  if (differences.length === 0) return { status: "unchanged", otherServers };
  if (!force) return { status: "differs", differences, otherServers };

  // Assigning keeps the entry where it was among the servers.
  servers[SERVER_NAME] = { ...entry, ...(isObject(current) ? keptKeys(current) : {}) };
  return { status: "update", text: jsonText(data, eol), replaced: true, otherServers };
}

/** The `[mcp_servers.<name>]` path of the Codex table. */
const CODEX_TABLE: readonly string[] = ["mcp_servers", SERVER_NAME];

/**
 * The Codex config with the `[mcp_servers.cypress]` table appended, or
 * replaced in place with --force. Only that table's own lines change: other
 * tables, comments and sub-tables such as `[mcp_servers.cypress.env]` stay
 * byte for byte.
 */
export function mergeToml(
  existing: string | undefined,
  entry: ServerEntry,
  force: boolean,
): MergeResult {
  const table = tomlTable(CODEX_TABLE, entry);
  if (existing === undefined) {
    return { status: "create", text: table, replaced: false, otherServers: 0 };
  }

  let statements: TomlStatement[];
  try {
    statements = parseTomlDocument(existing);
  } catch (err) {
    if (!(err instanceof TomlSyntaxError)) throw err;
    return refused(`init cannot edit it safely (${err.message})`);
  }
  const problem = unsupportedShape(statements);
  if (problem) return refused(`init cannot edit it safely: ${problem}`);

  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const otherServers = countOtherServers(statements);
  const header = statements.find(
    (s): s is TomlTableHeader => s.kind === "table" && samePath(s.path, CODEX_TABLE),
  );
  if (!header) {
    const head = existing.trimEnd();
    const text = `${head}${head ? eol + eol : ""}${withEol(table, eol)}`;
    return { status: "update", text, replaced: false, otherServers };
  }

  const body = statements.filter(
    (s): s is TomlEntry => s.kind === "entry" && samePath(s.table, CODEX_TABLE),
  );
  const current: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const line of body) {
    if (line.key.length === 1) current[line.key[0]!] = line.value;
  }
  const differences = differencesFrom(current, entry);
  if (differences.length === 0) return { status: "unchanged", otherServers };
  if (!force) return { status: "differs", differences, otherServers };

  // From the header to the table's last key: comments after it belong to
  // whatever comes next.
  const end = Math.max(header.end, ...body.map((line) => line.end));
  const kept = body
    .filter((line) => KEPT_KEYS.has(line.key[0]!))
    .map((line) => {
      const text = existing.slice(line.start, line.end);
      return text.endsWith("\n") ? text : text + eol;
    });
  const text =
    existing.slice(0, header.start) +
    withEol(table, eol) +
    kept.join("") +
    existing.slice(end);
  return { status: "update", text, replaced: true, otherServers };
}

/**
 * Why init cannot edit the document, or undefined. It only edits a
 * `[mcp_servers.cypress]` table header and the keys under it; the same server
 * defined with dotted keys or inline tables would need a rewrite.
 */
function unsupportedShape(statements: readonly TomlStatement[]): string | undefined {
  const related = (path: readonly string[]): boolean =>
    startsWith(path, CODEX_TABLE) || startsWith(CODEX_TABLE, path);
  let headers = 0;
  for (const s of statements) {
    if (s.kind === "table") {
      if (s.array && related(s.path)) {
        return `it has [[${s.path.join(".")}]] array tables`;
      }
      if (samePath(s.path, CODEX_TABLE)) headers += 1;
    } else if (!startsWith(s.table, CODEX_TABLE)) {
      const full = [...s.table, ...s.key];
      if (related(full)) {
        return `it defines ${full.join(".")} with a dotted key or an inline table`;
      }
    }
  }
  return headers > 1 ? "it has [mcp_servers.cypress] twice" : undefined;
}

function countOtherServers(statements: readonly TomlStatement[]): number {
  const names = new Set<string>();
  for (const s of statements) {
    const path = s.kind === "table" ? s.path : [...s.table, ...s.key];
    if (path[0] === CODEX_TABLE[0] && path[1] !== undefined && path[1] !== SERVER_NAME) {
      names.add(path[1]);
    }
  }
  return names.size;
}

/** One line per key init writes whose current value is another. */
function differencesFrom(current: Record<string, unknown>, entry: ServerEntry): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(entry)) {
    const has = Object.hasOwn(current, key);
    if (has && sameValue(current[key], value)) continue;
    lines.push(
      has
        ? `${key} is ${show(current[key])}, init writes ${show(value)}`
        : `${key} is not set, init writes ${show(value)}`,
    );
  }
  return lines;
}

function keptKeys(current: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(current).filter(([key]) => KEPT_KEYS.has(key)),
  );
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
    );
  }
  return a === b;
}

function show(value: unknown): string {
  return value instanceof RawValue ? value.text : JSON.stringify(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof RawValue)
  );
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && startsWith(a, b);
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((part, i) => path[i] === part);
}

function jsonText(data: unknown, eol: string): string {
  return withEol(`${JSON.stringify(data, null, 2)}\n`, eol);
}

function withEol(text: string, eol: string): string {
  return eol === "\n" ? text : text.replace(/\n/g, eol);
}

function refused(reason: string): MergeResult {
  return { status: "refused", reason };
}

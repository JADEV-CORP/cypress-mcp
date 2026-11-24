// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0

// `cypress-mcp init`: writes the cypress server entry into the MCP client
// config files of the project it runs in, merged with what is there, and
// prints the entry for clients configured outside the project. Most setup
// mistakes came from copying JSON from the README by hand: a wrong key, a
// relative --cwd, no timeout.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ProjectRegistry,
  ProjectRequiredError,
  type Discovery,
  type DiscoveryOptions,
} from "../services/projects.js";
import type { ToolContext } from "../types/index.js";
import { CypressMcpError } from "../utils/errors.js";
import {
  CLIENT_NAMES,
  configTargets,
  outsideSnippets,
  type ClientId,
  type ConfigTarget,
  type Machine,
  type OutsideSnippet,
} from "./clients.js";
import { mergeJson, mergeToml, SERVER_NAME, type MergeStatus } from "./merge.js";
import { tomlTable } from "./toml.js";

export interface InitOptions {
  /** The project folder, absolute: where the files go and the server's --cwd */
  readonly root: string;
  /** Cypress projects found there, "." for the root itself */
  readonly projects: readonly string[];
  readonly clients: readonly ClientId[];
  readonly force?: boolean;
  readonly dryRun?: boolean;
  /** Where Claude Desktop's config lives. Default: this machine */
  readonly machine?: Machine;
}

export interface FileReport {
  /** Relative to the project, with forward slashes */
  readonly file: string;
  readonly path: string;
  readonly clients: ClientId[];
  readonly status: MergeStatus;
  /** False for a dry run, and for unchanged, differs and refused */
  readonly written: boolean;
  readonly replaced?: boolean;
  readonly otherServers?: number;
  readonly differences?: string[];
  readonly reason?: string;
  /** The entry holds this machine's path to the project */
  readonly machinePath: boolean;
  /** The entry as it appears in the file, to read or add by hand */
  readonly snippet: string;
}

export interface InitReport {
  readonly root: string;
  readonly projects: readonly string[];
  readonly dryRun: boolean;
  /** Every file is written, would be, or is already up to date */
  readonly ok: boolean;
  readonly clients: readonly ClientId[];
  readonly files: FileReport[];
  readonly outside: OutsideSnippet[];
  readonly notes: string[];
  readonly next: string;
}

/**
 * The Cypress projects in `root`, found the way the server finds them, with
 * its limits: never from the disk root, the home folder or above it. Throws
 * CONFIG_NOT_FOUND worded for init.
 */
export async function findProjects(
  root: string,
  options: DiscoveryOptions = {},
): Promise<Discovery> {
  // discover() never creates a project context.
  const registry = new ProjectRegistry(root, noContext, options);
  let discovery: Discovery;
  try {
    discovery = await registry.discover();
  } catch (err) {
    if (!(err instanceof ProjectRequiredError)) throw err;
    if (statSync(root, { throwIfNoEntry: false })?.isDirectory() !== true) {
      throw new CypressMcpError(
        `${root} does not exist or is not a folder.`,
        "CONFIG_NOT_FOUND",
        "Pass --cwd with the project folder.",
      );
    }
    throw new CypressMcpError(
      `${root} has no cypress.config.*, and cypress-mcp does not look for projects in the disk root, the home folder or a folder above it.`,
      "CONFIG_NOT_FOUND",
      "Run cypress-mcp init in the project folder, or pass --cwd <project folder>.",
    );
  }
  if (discovery.projects.length === 0) {
    const stopped = discovery.stoppedEarly
      ? ` (the search stopped ${discovery.stoppedEarly})`
      : "";
    throw new CypressMcpError(
      `No cypress.config.* in ${root} or its subfolders${stopped}.`,
      "CONFIG_NOT_FOUND",
      "Run it in the folder that holds cypress.config.*, or pass --cwd with that folder.",
    );
  }
  return discovery;
}

function noContext(): ToolContext {
  throw new Error("cypress-mcp init does not open a project");
}

/** Writes (or with dryRun, plans) every file, and reports what happened. */
export async function initProject(options: InitOptions): Promise<InitReport> {
  const { root, clients, dryRun = false } = options;
  const targets = configTargets(root, clients);
  const files: FileReport[] = [];
  for (const target of targets) {
    files.push(await applyTarget(root, target, options.force === true, dryRun));
  }
  const outside = outsideSnippets(root, clients, options.machine ?? thisMachine());
  const ok = files.every(
    (file) => file.status !== "differs" && file.status !== "refused",
  );
  return {
    root,
    projects: options.projects,
    dryRun,
    ok,
    clients,
    files,
    outside,
    notes: notes(root, targets, files, outside.length > 0),
    next: nextStep(clients, files, dryRun, ok),
  };
}

async function applyTarget(
  root: string,
  target: ConfigTarget,
  force: boolean,
  dryRun: boolean,
): Promise<FileReport> {
  const absolute = path.join(root, ...target.file.split("/"));
  const base = {
    file: target.file,
    path: absolute,
    clients: target.clients,
    machinePath: target.machinePath,
    snippet: snippet(target),
  };

  let existing: string | undefined;
  try {
    existing = await readFile(absolute, "utf-8");
  } catch (err) {
    if (errorCode(err) !== "ENOENT") {
      return {
        ...base,
        status: "refused",
        written: false,
        reason: `init cannot read it (${message(err)})`,
      };
    }
  }

  const { text, ...result } =
    target.format === "toml"
      ? mergeToml(existing, target.entry, force)
      : mergeJson(existing, target.container, target.entry, force);
  const report: FileReport = { ...base, ...result, written: false };
  if (dryRun || text === undefined) return report;

  try {
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, text);
  } catch (err) {
    return {
      ...base,
      status: "refused",
      written: false,
      reason: `init cannot write it (${message(err)})`,
    };
  }
  return { ...report, written: true };
}

/** The entry as it sits in the file. */
function snippet(target: ConfigTarget): string {
  return target.format === "toml"
    ? tomlTable([target.container, SERVER_NAME], target.entry).trimEnd()
    : JSON.stringify({ [target.container]: { [SERVER_NAME]: target.entry } }, null, 2);
}

function notes(
  root: string,
  targets: readonly ConfigTarget[],
  files: readonly FileReport[],
  printedOutside: boolean,
): string[] {
  const lines: string[] = [];
  const local = files
    .filter(
      (file) =>
        file.machinePath && (file.status === "create" || file.status === "update"),
    )
    .map((file) => file.file);
  if (local.length > 0) {
    lines.push(
      `${joinWords(local)} ${local.length === 1 ? "has" : "have"} the absolute path ${root}: on another machine, run cypress-mcp init there.`,
    );
  }
  lines.push(...targets.flatMap((target) => target.notes));
  if (!printedOutside) {
    lines.push(
      "Claude Desktop, Zed, JetBrains AI Assistant and the Copilot cloud agent keep their config outside the project: --client claude-desktop, zed, jetbrains or copilot-cloud prints it.",
    );
  }
  return lines;
}

function nextStep(
  clients: readonly ClientId[],
  files: readonly FileReport[],
  dryRun: boolean,
  ok: boolean,
): string {
  // Only clients configured outside the project: nothing to write here.
  if (files.length === 0) {
    return "add each entry above where it says, then ask the agent to run cypress_doctor";
  }
  const differs = files.some((file) => file.status === "differs");
  if (dryRun) {
    return differs
      ? "run it again without --dry-run, and with --force to replace the cypress entries that differ"
      : "run it again without --dry-run to write the files";
  }
  if (differs) {
    return "run it again with --force to replace the cypress entries that differ, or edit them by hand";
  }
  if (!ok) {
    return "add the entries shown above by hand, then restart or reload the client and ask the agent to run cypress_doctor";
  }
  return `restart or reload ${joinWords(clients.map((id) => CLIENT_NAMES[id]))}, then ask the agent to run cypress_doctor`;
}

/** The report as a person reads it in a terminal. */
export function formatInitReport(report: InitReport): string {
  const { root, projects, dryRun } = report;
  const lines: string[] = [
    projects.length === 1 && projects[0] === "."
      ? `Cypress project: ${root}`
      : `Cypress projects under ${root}: ${projects.join(", ")}`,
  ];
  if (dryRun) lines.push("Dry run: nothing is written.");

  for (const file of report.files) {
    lines.push("", fileLine(file, dryRun));
    if (file.status === "differs") {
      lines.push(...file.differences!.map((line) => `  ${line}`), "  init writes:");
    }
    if (file.status !== "unchanged") lines.push(indent(file.snippet));
  }
  for (const outside of report.outside) {
    lines.push("", `${outside.name}: ${outside.where}`, indent(outside.text));
    if (outside.note) lines.push(`  ${outside.note}`);
  }

  lines.push("");
  for (const note of report.notes) lines.push(`note: ${note}`);
  lines.push(`next: ${report.next}`);
  return lines.join("\n");
}

function fileLine(file: FileReport, dryRun: boolean): string {
  const where = `${file.file} (${file.clients.map((id) => CLIENT_NAMES[id]).join(", ")})`;
  switch (file.status) {
    case "create":
      return `${dryRun ? "would create" : "created"} ${where}`;
    case "update": {
      const others = file.otherServers ?? 0;
      const detail = file.replaced
        ? "replaced the cypress entry"
        : `added cypress${others > 0 ? `, kept ${others} other server${others === 1 ? "" : "s"}` : ""}`;
      return `${dryRun ? "would update" : "updated"} ${where}: ${detail}`;
    }
    case "unchanged":
      return `unchanged ${where}: cypress is already set up`;
    case "differs":
      return `not written ${where}: its cypress entry differs, --force replaces it`;
    case "refused":
      return `not written ${where}: ${file.reason}. Add the entry by hand:`;
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function joinWords(words: readonly string[]): string {
  return words.length <= 1
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function thisMachine(): Machine {
  const appData = process.env["APPDATA"];
  return {
    home: os.homedir(),
    platform: process.platform,
    ...(appData ? { appData } : {}),
  };
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Copyright (c) 2026 JADEV GROUP SARL
// SPDX-License-Identifier: Apache-2.0

// The MCP clients `cypress-mcp init` knows, where each keeps its servers and
// the entry it needs. The formats, keys, timeouts and paths are the ones
// README.md documents under Setup, checked against each client's docs: keep
// both in step. A path is relative (${workspaceFolder}) where the client
// supports it, so the file can be committed for the team, and absolute only
// where the client documents no other way.
import { existsSync } from "node:fs";
import path from "node:path";
import { SERVER_NAME, type ServerEntry } from "./merge.js";

/** Clients whose config is a file in the project: init writes it. */
export const PROJECT_CLIENTS = [
  "claude",
  "vscode",
  "vscode-legacy",
  "cursor",
  "kiro",
  "gemini",
  "junie",
  "devin",
  "codex",
] as const;

/** Clients configured outside the project: init prints the entry and where it goes. */
export const OUTSIDE_CLIENTS = [
  "claude-desktop",
  "zed",
  "jetbrains",
  "copilot-cloud",
] as const;

type ProjectClientId = (typeof PROJECT_CLIENTS)[number];
type OutsideClientId = (typeof OUTSIDE_CLIENTS)[number];
export type ClientId = ProjectClientId | OutsideClientId;

export const CLIENT_NAMES: Readonly<Record<ClientId, string>> = {
  claude: "Claude Code",
  vscode: "VS Code Copilot",
  "vscode-legacy": "VS Code, .vscode/mcp.json",
  cursor: "Cursor",
  kiro: "Kiro",
  gemini: "Gemini CLI",
  junie: "JetBrains Junie",
  devin: "Devin Desktop",
  codex: "Codex",
  "claude-desktop": "Claude Desktop",
  zed: "Zed",
  jetbrains: "JetBrains AI Assistant",
  "copilot-cloud": "GitHub Copilot cloud agent",
};

/** Other names people type for a client. */
const ALIASES: Readonly<Record<string, ClientId>> = {
  "claude-code": "claude",
  windsurf: "devin",
};

/** 15 minutes: above cypress-mcp's 5 minute run default, for long suites. */
const TIMEOUT_MS = 900_000;
const WORKSPACE = "${workspaceFolder}";

interface ProjectFile {
  /** Relative to the project, with forward slashes */
  readonly file: string;
  readonly format: "json" | "toml";
  /** The object that holds the servers */
  readonly container: string;
}

const FILES: Readonly<Record<ProjectClientId, ProjectFile>> = {
  claude: { file: ".mcp.json", format: "json", container: "mcpServers" },
  vscode: { file: ".mcp.json", format: "json", container: "mcpServers" },
  "vscode-legacy": { file: ".vscode/mcp.json", format: "json", container: "servers" },
  cursor: { file: ".cursor/mcp.json", format: "json", container: "mcpServers" },
  kiro: { file: ".kiro/settings/mcp.json", format: "json", container: "mcpServers" },
  gemini: { file: ".gemini/settings.json", format: "json", container: "mcpServers" },
  junie: { file: ".junie/mcp/mcp.json", format: "json", container: "mcpServers" },
  devin: { file: ".devin/mcp_config.json", format: "json", container: "mcpServers" },
  codex: { file: ".codex/config.toml", format: "toml", container: "mcp_servers" },
};

/** What a person needs to know about a client's file once it is written. */
const NOTES: Readonly<Partial<Record<ProjectClientId, string>>> = {
  "vscode-legacy":
    "VS Code marks .vscode/mcp.json deprecated (removal planned for February 2027); --client vscode writes .mcp.json instead.",
  gemini:
    "Gemini CLI connects stdio servers only in trusted folders: if gemini mcp list shows cypress as Disconnected, run gemini trust in the project.",
  codex: "Codex reads .codex/config.toml only in a trusted project.",
};

/** One config file to write, and the clients that read it. */
export interface ConfigTarget extends ProjectFile {
  readonly clients: ClientId[];
  readonly entry: ServerEntry;
  /** The entry holds this machine's path to the project */
  readonly machinePath: boolean;
  readonly notes: string[];
}

/** The files to write for these clients, in a fixed order, one per file. */
export function configTargets(
  root: string,
  clients: readonly ClientId[],
): ConfigTarget[] {
  const byFile = new Map<string, ProjectClientId[]>();
  for (const id of PROJECT_CLIENTS) {
    if (!clients.includes(id)) continue;
    const { file } = FILES[id];
    byFile.set(file, [...(byFile.get(file) ?? []), id]);
  }
  return [...byFile.values()].map((ids) => {
    // Claude Code and VS Code Copilot both read .mcp.json. VS Code needs the
    // path and the tools; Claude Code accepts them.
    const id = ids.includes("vscode") ? "vscode" : ids[0]!;
    const entry = projectEntry(id, root);
    return {
      ...FILES[id],
      clients: ids,
      entry,
      machinePath: Object.values(entry).some(
        (value) => value === root || (Array.isArray(value) && value.includes(root)),
      ),
      notes: ids.flatMap((client) => NOTES[client] ?? []),
    };
  });
}

function serverArgs(cwd?: string): string[] {
  return cwd === undefined ? ["-y", "cypress-mcp"] : ["-y", "cypress-mcp", "--cwd", cwd];
}

function projectEntry(id: ProjectClientId, root: string): ServerEntry {
  switch (id) {
    case "claude":
      // Claude Code sets CLAUDE_PROJECT_DIR for its servers: no path needed.
      return { type: "stdio", command: "npx", args: serverArgs(), timeout: TIMEOUT_MS };
    case "vscode":
      // .mcp.json has no workspace variable in VS Code, and a 30 s default timeout.
      return {
        type: "stdio",
        command: "npx",
        args: serverArgs(root),
        tools: ["*"],
        timeout: TIMEOUT_MS,
      };
    case "vscode-legacy":
    case "cursor":
      return { type: "stdio", command: "npx", args: serverArgs(WORKSPACE) };
    case "kiro":
      // Use an absolute path because the Kiro docs don't specify workspace interpolation for args.
      return { command: "npx", args: serverArgs(root) };
    case "gemini":
      return { command: "npx", args: serverArgs(), cwd: root, timeout: TIMEOUT_MS };
    case "junie":
      return { command: "npx", args: serverArgs(root), timeout: TIMEOUT_MS };
    case "devin":
      return { command: "npx", args: serverArgs(root) };
    case "codex":
      // Codex gives a server 10 s to start and a tool call 60 s by default.
      return {
        command: "npx",
        args: serverArgs(root),
        startup_timeout_sec: 30,
        tool_timeout_sec: 900,
      };
  }
}

/** Where this machine keeps user config, for Claude Desktop's file. */
export interface Machine {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  /** %APPDATA% on Windows */
  readonly appData?: string;
}

/** The entry for a client configured outside the project, and where it goes. */
export interface OutsideSnippet {
  readonly client: ClientId;
  readonly name: string;
  /** Where to put it, with absolute paths */
  readonly where: string;
  readonly text: string;
  readonly note?: string;
}

export function outsideSnippets(
  root: string,
  clients: readonly ClientId[],
  machine: Machine,
): OutsideSnippet[] {
  return OUTSIDE_CLIENTS.filter((id) => clients.includes(id)).map((id) => ({
    client: id,
    name: CLIENT_NAMES[id],
    ...outsideEntry(id, root, machine),
  }));
}

function outsideEntry(
  id: OutsideClientId,
  root: string,
  machine: Machine,
): { where: string; text: string; note?: string } {
  const servers = (container: string, entry: object): string =>
    JSON.stringify({ [container]: { [SERVER_NAME]: entry } }, null, 2);
  switch (id) {
    case "claude-desktop":
      // Claude Desktop starts servers in / and reads no project file.
      return {
        where: `add to ${claudeDesktopConfig(machine)}, then restart Claude Desktop`,
        text: servers("mcpServers", { command: "npx", args: serverArgs(root) }),
      };
    case "zed":
      return {
        where: "add to Zed's settings.json (zed: open settings)",
        text: servers("context_servers", {
          command: "npx",
          args: serverArgs(root),
          timeout: 600,
        }),
        note: "Zed caps tool calls at 600 s: keep cypress-mcp runs under 10 minutes (the 5 minute default is fine).",
      };
    case "jetbrains":
      return {
        where: `in Settings, open Tools, AI Assistant, Model Context Protocol (MCP), click Add, paste this and set Working directory to ${root}`,
        text: servers("mcpServers", { command: "npx", args: serverArgs() }),
      };
    case "copilot-cloud":
      return {
        where: "on GitHub, in the repository's Settings, Copilot, MCP servers",
        text: servers("mcpServers", {
          type: "local",
          command: "npx",
          args: serverArgs("."),
          tools: ["*"],
        }),
        note: "The agent's firewall blocks download.cypress.io: install the Cypress binary in .github/workflows/copilot-setup-steps.yml (README, GitHub Copilot cloud agent).",
      };
  }
}

function claudeDesktopConfig({ home, platform, appData }: Machine): string {
  const file = "claude_desktop_config.json";
  if (platform === "darwin") {
    return path.posix.join(home, "Library", "Application Support", "Claude", file);
  }
  if (platform === "win32") {
    return path.win32.join(
      appData ?? path.win32.join(home, "AppData", "Roaming"),
      "Claude",
      file,
    );
  }
  return path.posix.join(home, ".config", "Claude", file);
}

/** `--client` values: repeated, comma lists, any case, aliases; each once. */
export function parseClients(values: readonly string[]): {
  clients: ClientId[];
  unknown: string[];
} {
  const clients: ClientId[] = [];
  const unknown: string[] = [];
  for (const name of values.flatMap((value) => value.split(","))) {
    const key = name.trim().toLowerCase();
    if (key === "") continue;
    const id = ALIASES[key] ?? (isClientId(key) ? key : undefined);
    if (id === undefined) unknown.push(name.trim());
    else if (!clients.includes(id)) clients.push(id);
  }
  return { clients, unknown };
}

function isClientId(name: string): name is ClientId {
  return Object.hasOwn(CLIENT_NAMES, name);
}

/** A file or folder in the project that shows a client is used there. */
const MARKERS: readonly (readonly [string, ProjectClientId])[] = [
  [".mcp.json", "claude"],
  [".claude", "claude"],
  [".vscode/mcp.json", "vscode-legacy"],
  [".vscode", "vscode"],
  [".cursor", "cursor"],
  [".kiro", "kiro"],
  [".gemini", "gemini"],
  [".junie", "junie"],
  [".devin", "devin"],
  [".codex", "codex"],
];

/** The clients the project shows signs of, else .mcp.json for Claude Code. */
export function detectClients(root: string): ClientId[] {
  const found = new Set<ClientId>();
  for (const [marker, id] of MARKERS) {
    if (existsSync(path.join(root, marker))) found.add(id);
  }
  // A project that keeps VS Code servers in .vscode/mcp.json gets the entry there.
  if (found.has("vscode-legacy")) found.delete("vscode");
  return found.size > 0 ? PROJECT_CLIENTS.filter((id) => found.has(id)) : ["claude"];
}

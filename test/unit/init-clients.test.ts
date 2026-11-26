// What `cypress-mcp init` writes for each MCP client. The expected entries are
// the ones README.md documents under Setup, which were checked against each
// client's docs: a change here must match a change there.
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configTargets,
  detectClients,
  outsideSnippets,
  parseClients,
  type ClientId,
} from "../../src/setup/clients.js";

const ROOT = "/work/shop";

function only(id: ClientId) {
  const targets = configTargets(ROOT, [id]);
  expect(targets).toHaveLength(1);
  return targets[0]!;
}

describe("the entry written for each client in the project", () => {
  it("Claude Code: .mcp.json, no path (CLAUDE_PROJECT_DIR), a timeout in ms", () => {
    const target = only("claude");
    expect(target).toMatchObject({
      file: ".mcp.json",
      format: "json",
      container: "mcpServers",
      clients: ["claude"],
      machinePath: false,
    });
    expect(target.entry).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "cypress-mcp"],
      timeout: 900000,
    });
  });

  it("VS Code Copilot: .mcp.json with the absolute --cwd, tools and a timeout", () => {
    const target = only("vscode");
    expect(target).toMatchObject({
      file: ".mcp.json",
      container: "mcpServers",
      clients: ["vscode"],
      machinePath: true,
    });
    expect(target.entry).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "cypress-mcp", "--cwd", ROOT],
      tools: ["*"],
      timeout: 900000,
    });
  });

  it("Claude Code and VS Code share one .mcp.json entry, VS Code's", () => {
    const targets = configTargets(ROOT, ["vscode", "claude"]);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.clients).toEqual(["claude", "vscode"]);
    expect(targets[0]!.entry).toEqual(only("vscode").entry);
  });

  it("VS Code legacy: .vscode/mcp.json under servers, with ${workspaceFolder}", () => {
    const target = only("vscode-legacy");
    expect(target).toMatchObject({
      file: ".vscode/mcp.json",
      container: "servers",
      machinePath: false,
    });
    expect(target.entry).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "cypress-mcp", "--cwd", "${workspaceFolder}"],
    });
  });

  it("Cursor: .cursor/mcp.json with ${workspaceFolder}", () => {
    const target = only("cursor");
    expect(target).toMatchObject({
      file: ".cursor/mcp.json",
      container: "mcpServers",
      machinePath: false,
    });
    expect(target.entry).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "cypress-mcp", "--cwd", "${workspaceFolder}"],
    });
  });

  it("Kiro: .kiro/settings/mcp.json with the project path", () => {
    expect(parseClients(["Kiro"])).toEqual({ clients: ["kiro"], unknown: [] });
    const target = only("kiro");
    expect(target).toMatchObject({
      file: ".kiro/settings/mcp.json",
      container: "mcpServers",
      machinePath: true,
    });
    expect(target.entry).toEqual({
      command: "npx",
      args: ["-y", "cypress-mcp", "--cwd", ROOT],
    });
  });

  it("Gemini CLI: .gemini/settings.json with cwd and a timeout", () => {
    const target = only("gemini");
    expect(target).toMatchObject({
      file: ".gemini/settings.json",
      container: "mcpServers",
      machinePath: true,
    });
    expect(target.entry).toEqual({
      command: "npx",
      args: ["-y", "cypress-mcp"],
      cwd: ROOT,
      timeout: 900000,
    });
  });

  it("Junie: .junie/mcp/mcp.json with a timeout", () => {
    const target = only("junie");
    expect(target).toMatchObject({ file: ".junie/mcp/mcp.json", machinePath: true });
    expect(target.entry).toEqual({
      command: "npx",
      args: ["-y", "cypress-mcp", "--cwd", ROOT],
      timeout: 900000,
    });
  });

  it("Devin Desktop: .devin/mcp_config.json", () => {
    const target = only("devin");
    expect(target).toMatchObject({ file: ".devin/mcp_config.json", machinePath: true });
    expect(target.entry).toEqual({
      command: "npx",
      args: ["-y", "cypress-mcp", "--cwd", ROOT],
    });
  });

  it("Codex: .codex/config.toml with both timeouts in seconds", () => {
    const target = only("codex");
    expect(target).toMatchObject({
      file: ".codex/config.toml",
      format: "toml",
      container: "mcp_servers",
      machinePath: true,
    });
    expect(target.entry).toEqual({
      command: "npx",
      args: ["-y", "cypress-mcp", "--cwd", ROOT],
      startup_timeout_sec: 30,
      tool_timeout_sec: 900,
    });
  });

  it("lists the files in a fixed order and skips clients configured outside", () => {
    const targets = configTargets(ROOT, ["codex", "zed", "cursor", "claude"]);
    expect(targets.map((target) => target.file)).toEqual([
      ".mcp.json",
      ".cursor/mcp.json",
      ".codex/config.toml",
    ]);
  });
});

describe("clients configured outside the project", () => {
  const mac = { home: "/Users/me", platform: "darwin" as const };

  it("Claude Desktop: absolute --cwd and the config path of the platform", () => {
    const [desktop] = outsideSnippets(ROOT, ["claude-desktop"], mac);
    expect(desktop!.where).toContain(
      "/Users/me/Library/Application Support/Claude/claude_desktop_config.json",
    );
    expect(desktop!.where).toContain("restart Claude Desktop");
    expect(JSON.parse(desktop!.text)).toEqual({
      mcpServers: {
        cypress: { command: "npx", args: ["-y", "cypress-mcp", "--cwd", ROOT] },
      },
    });

    const [linux] = outsideSnippets(ROOT, ["claude-desktop"], {
      home: "/home/me",
      platform: "linux",
    });
    expect(linux!.where).toContain("/home/me/.config/Claude/claude_desktop_config.json");

    const [windows] = outsideSnippets("C:\\work\\shop", ["claude-desktop"], {
      home: "C:\\Users\\me",
      platform: "win32",
      appData: "C:\\Users\\me\\AppData\\Roaming",
    });
    expect(windows!.where).toContain(
      "C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
    );
    expect(JSON.parse(windows!.text)).toMatchObject({
      mcpServers: { cypress: { args: ["-y", "cypress-mcp", "--cwd", "C:\\work\\shop"] } },
    });
  });

  it("Zed: context_servers with the absolute --cwd and its 600 s cap", () => {
    const [zed] = outsideSnippets(ROOT, ["zed"], mac);
    expect(zed!.where).toContain("settings.json");
    expect(JSON.parse(zed!.text)).toEqual({
      context_servers: {
        cypress: {
          command: "npx",
          args: ["-y", "cypress-mcp", "--cwd", ROOT],
          timeout: 600,
        },
      },
    });
  });

  it("JetBrains AI Assistant: no --cwd, the working directory field instead", () => {
    const [jetbrains] = outsideSnippets(ROOT, ["jetbrains"], mac);
    expect(jetbrains!.where).toContain(`Working directory to ${ROOT}`);
    expect(JSON.parse(jetbrains!.text)).toEqual({
      mcpServers: { cypress: { command: "npx", args: ["-y", "cypress-mcp"] } },
    });
  });

  it("Copilot cloud agent: type local, --cwd . and every tool", () => {
    const [cloud] = outsideSnippets(ROOT, ["copilot-cloud"], mac);
    expect(cloud!.where).toContain("Settings, Copilot, MCP servers");
    expect(cloud!.note).toContain("copilot-setup-steps.yml");
    expect(JSON.parse(cloud!.text)).toEqual({
      mcpServers: {
        cypress: {
          type: "local",
          command: "npx",
          args: ["-y", "cypress-mcp", "--cwd", "."],
          tools: ["*"],
        },
      },
    });
  });

  it("prints nothing for clients with a file in the project", () => {
    expect(outsideSnippets(ROOT, ["claude", "cursor"], mac)).toEqual([]);
  });
});

describe("--client names", () => {
  it("takes repeated values, comma lists, any case and aliases, once each", () => {
    expect(parseClients(["cursor,Codex", "claude-code", " windsurf ", "cursor"])).toEqual(
      {
        clients: ["cursor", "codex", "claude", "devin"],
        unknown: [],
      },
    );
  });

  it("reports the names it does not know", () => {
    expect(parseClients(["cursor,vim", "emacs"])).toEqual({
      clients: ["cursor"],
      unknown: ["vim", "emacs"],
    });
  });
});

describe("clients found in the project", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  function folder(...entries: string[]): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-mcp-detect-"));
    roots.push(root);
    for (const entry of entries) {
      const target = path.join(root, entry);
      if (entry.endsWith("/")) fs.mkdirSync(target, { recursive: true });
      else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "{}\n");
      }
    }
    return root;
  }

  it("defaults to .mcp.json (Claude Code) when nothing is there", () => {
    expect(detectClients(folder())).toEqual(["claude"]);
  });

  it("finds each client from its folder or file", () => {
    expect(
      detectClients(
        folder(".cursor/", ".gemini/", ".junie/", ".devin/", ".codex/", ".vscode/"),
      ),
    ).toEqual(["vscode", "cursor", "gemini", "junie", "devin", "codex"]);
    expect(detectClients(folder(".mcp.json"))).toEqual(["claude"]);
    expect(detectClients(folder(".claude/"))).toEqual(["claude"]);
    expect(detectClients(folder(".kiro/"))).toEqual(["kiro"]);
  });

  it("keeps VS Code in .vscode/mcp.json when the project already has one", () => {
    expect(detectClients(folder(".vscode/mcp.json"))).toEqual(["vscode-legacy"]);
  });
});

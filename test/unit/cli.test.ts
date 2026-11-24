import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand, type CliIo } from "../../src/cli.js";

function io(interactive: boolean): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      cwd: process.cwd(),
      interactive,
    },
    out,
    err,
  };
}

describe("cypress-mcp without a command", () => {
  it("explains itself and exits 2 when a person runs it in a terminal", async () => {
    const terminal = io(true);

    expect(await runCommand([], terminal.io)).toBe(2);
    expect(await runCommand(["--cwd", "/work/shop"], terminal.io)).toBe(2);

    const note = terminal.err.join("\n");
    expect(note).toContain("MCP server");
    expect(note).toContain("https://github.com/JADEV-CORP/cypress-mcp#setup");
    expect(note).toContain("cypress-mcp run");
    expect(note).toContain("cypress-mcp doctor");
    expect(note).toContain("cypress-mcp list");
    expect(note).toContain("cypress-mcp init");
    expect(terminal.out).toEqual([]);
  });

  it("leaves stdin to the MCP server when a client pipes it", async () => {
    const client = io(false);

    expect(await runCommand([], client.io)).toBeUndefined();
    expect(await runCommand(["--cwd", "/work/shop", "--caps", "all"], client.io)).toBe(
      undefined,
    );
    expect(client.err).toEqual([]);
  });
});

describe("cypress-mcp init in a terminal", () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cypress-mcp-init-")));
    fs.writeFileSync(path.join(root, "cypress.config.js"), "module.exports = {};\n");
    fs.mkdirSync(path.join(root, ".cursor"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function terminal(interactive: boolean, answer: string) {
    const questions: string[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      cwd: root,
      interactive,
      ask: (question) => {
        questions.push(question);
        return Promise.resolve(answer);
      },
    };
    return { io, questions, out, err };
  }

  function exists(file: string): boolean {
    return fs.existsSync(path.join(root, file));
  }

  it("asks which clients to set up, and Enter keeps the ones found", async () => {
    const session = terminal(true, "");

    expect(await runCommand(["init"], session.io)).toBe(0);
    expect(session.questions).toHaveLength(1);
    expect(session.questions[0]).toContain("claude, vscode, vscode-legacy, cursor");
    expect(session.questions[0]).toContain("Enter for cursor");
    expect(exists(".cursor/mcp.json")).toBe(true);
    expect(exists(".mcp.json")).toBe(false);
  });

  it("sets up the clients typed in", async () => {
    const session = terminal(true, "codex, claude");

    expect(await runCommand(["init"], session.io)).toBe(0);
    expect(exists(".codex/config.toml")).toBe(true);
    expect(exists(".mcp.json")).toBe(true);
    expect(exists(".cursor/mcp.json")).toBe(false);
  });

  it("exits 2 on a client it does not know", async () => {
    const session = terminal(true, "cursor, vim");

    expect(await runCommand(["init"], session.io)).toBe(2);
    expect(session.err.join("\n")).toContain("Unknown client: vim");
    expect(exists(".cursor/mcp.json")).toBe(false);
  });

  it("writes nothing when the question is cancelled with Ctrl+C or Ctrl+D", async () => {
    const session = terminal(true, "");
    const cancelled: CliIo = {
      ...session.io,
      ask: () => Promise.reject(new Error("Aborted with Ctrl+D")),
    };

    expect(await runCommand(["init"], cancelled)).toBe(2);
    expect(session.err).toEqual(["Cancelled: nothing is written."]);
    expect(session.out).toEqual([]);
    expect(exists(".cursor/mcp.json")).toBe(false);
  });

  it("never asks with --yes, --client or --json, or without a terminal", async () => {
    const runs: [string[], boolean][] = [
      [["init", "--yes"], true],
      [["init", "-y", "--dry-run"], true],
      [["init", "--client", "cursor"], true],
      [["init", "--json"], true],
      [["init"], false],
    ];
    for (const [argv, interactive] of runs) {
      const session = terminal(interactive, "codex");
      expect(await runCommand(argv, session.io), argv.join(" ")).toBe(0);
      expect(session.questions, argv.join(" ")).toEqual([]);
    }
    expect(exists(".cursor/mcp.json")).toBe(true);
    expect(exists(".codex/config.toml")).toBe(false);
  });
});

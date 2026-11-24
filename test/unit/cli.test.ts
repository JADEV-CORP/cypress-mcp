import { describe, expect, it } from "vitest";
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
    expect(note).toContain("https://github.com/jams4code/cypress-mcp#setup");
    expect(note).toContain("cypress-mcp run");
    expect(note).toContain("cypress-mcp doctor");
    expect(note).toContain("cypress-mcp list");
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

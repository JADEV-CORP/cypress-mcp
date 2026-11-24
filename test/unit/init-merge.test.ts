// How `cypress-mcp init` merges its entry into a client config that may
// already exist: everything else is kept, a differing cypress entry is only
// replaced with --force, and a file it cannot edit safely is left alone.
import { describe, expect, it } from "vitest";
import { mergeJson, mergeToml } from "../../src/setup/merge.js";

const ENTRY = {
  type: "stdio",
  command: "npx",
  args: ["-y", "cypress-mcp", "--cwd", "/work/shop"],
  timeout: 900000,
};

const CODEX = {
  command: "npx",
  args: ["-y", "cypress-mcp", "--cwd", "/work/shop"],
  startup_timeout_sec: 30,
  tool_timeout_sec: 900,
};

const CODEX_TABLE = `[mcp_servers.cypress]
command = "npx"
args = ["-y", "cypress-mcp", "--cwd", "/work/shop"]
startup_timeout_sec = 30
tool_timeout_sec = 900
`;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

describe("a JSON config", () => {
  it("is created with the entry, 2-space indent and a trailing newline", () => {
    const result = mergeJson(undefined, "mcpServers", ENTRY, false);
    expect(result.status).toBe("create");
    expect(result.text).toBe(json({ mcpServers: { cypress: ENTRY } }));
  });

  it("keeps every other server and setting, in their order", () => {
    const existing = JSON.stringify({
      theme: "dark",
      mcpServers: { github: { command: "gh-mcp" }, other: { url: "https://x" } },
      tail: [1, 2],
    });
    const result = mergeJson(existing, "mcpServers", ENTRY, false);

    expect(result).toMatchObject({ status: "update", replaced: false, otherServers: 2 });
    expect(result.text).toBe(
      json({
        theme: "dark",
        mcpServers: {
          github: { command: "gh-mcp" },
          other: { url: "https://x" },
          cypress: ENTRY,
        },
        tail: [1, 2],
      }),
    );
  });

  it("adds the servers object when the file has none, and reads an empty file", () => {
    expect(mergeJson('{"general": {}}', "servers", ENTRY, false).text).toBe(
      json({ general: {}, servers: { cypress: ENTRY } }),
    );
    expect(mergeJson("  \n", "mcpServers", ENTRY, false)).toMatchObject({
      status: "update",
      text: json({ mcpServers: { cypress: ENTRY } }),
    });
  });

  it("leaves an equal entry alone, extra keys such as env included", () => {
    const existing = json({
      mcpServers: { cypress: { ...ENTRY, env: { CYPRESS_RECORD_KEY: "$KEY" } } },
    });
    const result = mergeJson(existing, "mcpServers", ENTRY, false);
    expect(result.status).toBe("unchanged");
    expect(result.text).toBeUndefined();
  });

  it("does not replace an entry that differs, and says what differs", () => {
    const existing = json({
      mcpServers: { cypress: { command: "npx", args: ["-y", "cypress-mcp"] } },
    });
    const result = mergeJson(existing, "mcpServers", ENTRY, false);

    expect(result.status).toBe("differs");
    expect(result.text).toBeUndefined();
    expect(result.differences).toEqual([
      'type is not set, init writes "stdio"',
      'args is ["-y","cypress-mcp"], init writes ["-y","cypress-mcp","--cwd","/work/shop"]',
      "timeout is not set, init writes 900000",
    ]);
  });

  it("replaces it with --force in place, keeping env and envFile only", () => {
    const existing = json({
      mcpServers: {
        first: { command: "a" },
        cypress: {
          url: "https://cloud.example/mcp",
          env: { CYPRESS_RECORD_KEY: "$KEY" },
          envFile: ".env.cypress",
        },
        last: { command: "b" },
      },
    });
    const result = mergeJson(existing, "mcpServers", ENTRY, true);

    expect(result).toMatchObject({ status: "update", replaced: true, otherServers: 2 });
    expect(result.text).toBe(
      json({
        mcpServers: {
          first: { command: "a" },
          cypress: {
            ...ENTRY,
            env: { CYPRESS_RECORD_KEY: "$KEY" },
            envFile: ".env.cypress",
          },
          last: { command: "b" },
        },
      }),
    );
  });

  it("treats a cypress value that is not an object as a difference", () => {
    const existing = json({ mcpServers: { cypress: "off" } });
    expect(mergeJson(existing, "mcpServers", ENTRY, false)).toMatchObject({
      status: "differs",
      differences: ['cypress is "off", not an object'],
    });
    expect(mergeJson(existing, "mcpServers", ENTRY, true).text).toBe(
      json({ mcpServers: { cypress: ENTRY } }),
    );
  });

  it("refuses a file it cannot rewrite without losing something", () => {
    const comments = '{\n  // team servers\n  "mcpServers": {}\n}\n';
    expect(mergeJson(comments, "mcpServers", ENTRY, true)).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("not plain JSON"),
    });
    expect(mergeJson("[]", "mcpServers", ENTRY, true)).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("not a JSON object"),
    });
    expect(mergeJson('{"mcpServers": []}', "mcpServers", ENTRY, true)).toMatchObject({
      status: "refused",
      reason: expect.stringContaining('"mcpServers" is not an object'),
    });
  });

  it("keeps CRLF line endings and drops a byte order mark", () => {
    const existing = '\uFEFF{\r\n  "mcpServers": {}\r\n}\r\n';
    const result = mergeJson(existing, "mcpServers", ENTRY, false);
    expect(result.text).toBe(
      json({ mcpServers: { cypress: ENTRY } }).replace(/\n/g, "\r\n"),
    );
  });
});

describe("the Codex config.toml", () => {
  it("is created with the [mcp_servers.cypress] table", () => {
    expect(mergeToml(undefined, CODEX, false)).toEqual({
      status: "create",
      text: CODEX_TABLE,
      replaced: false,
      otherServers: 0,
    });
  });

  it("gets the table appended, the rest kept byte for byte", () => {
    const existing = `# team defaults
model = "o3"

[mcp_servers.github]
command = "gh-mcp"
args = [
  "stdio", # comment
]
`;
    const result = mergeToml(existing, CODEX, false);
    expect(result).toMatchObject({ status: "update", replaced: false, otherServers: 1 });
    expect(result.text).toBe(`${existing}\n${CODEX_TABLE}`);

    // No trailing newline, CRLF endings.
    const crlf = 'model = "o3"\r\n[tui]\r\nnotifications = true';
    expect(mergeToml(crlf, CODEX, false).text).toBe(
      `${crlf}\r\n\r\n${CODEX_TABLE.replace(/\n/g, "\r\n")}`,
    );
  });

  it("leaves an equal table alone, however it is laid out", () => {
    const existing = `[mcp_servers.cypress]
# added by hand
command = 'npx'
args = [
  "-y",
  "cypress-mcp", "--cwd",
  "/work/shop",
]
startup_timeout_sec = 30
tool_timeout_sec = 900.0
env_vars = ["CYPRESS_RECORD_KEY"]

[mcp_servers.cypress.env]
CYPRESS_CACHE_FOLDER = "/cache"
`;
    expect(mergeToml(existing, CODEX, false)).toMatchObject({ status: "unchanged" });
  });

  it("does not replace a table that differs, and says what differs", () => {
    const existing = `[mcp_servers.cypress]
command = "npx"
args = ["-y", "cypress-mcp"]
`;
    const result = mergeToml(existing, CODEX, false);
    expect(result.status).toBe("differs");
    expect(result.text).toBeUndefined();
    expect(result.differences).toEqual([
      'args is ["-y","cypress-mcp"], init writes ["-y","cypress-mcp","--cwd","/work/shop"]',
      "startup_timeout_sec is not set, init writes 30",
      "tool_timeout_sec is not set, init writes 900",
    ]);
  });

  it("replaces only that table with --force, keeping env_vars, env and sub-tables", () => {
    const before = `model = "o3"

[mcp_servers.cypress]
command = "node"
args = ["old.js"]
enabled = false
env_vars = ["CYPRESS_RECORD_KEY"]
env = { CYPRESS_CACHE_FOLDER = "/cache" }
`;
    const after = `
# the next table keeps its comment
[mcp_servers.cypress.env]
FOO = "bar"

[profiles.ci]
model = "o4"
`;
    const result = mergeToml(before + after, CODEX, true);
    expect(result).toMatchObject({ status: "update", replaced: true });
    expect(result.text).toBe(
      `model = "o3"

${CODEX_TABLE}env_vars = ["CYPRESS_RECORD_KEY"]
env = { CYPRESS_CACHE_FOLDER = "/cache" }
${after}`,
    );
  });

  it("does not take text inside strings or arrays for a table header", () => {
    const existing = `instructions = """
[mcp_servers.cypress]
command = "fake"
"""
note = '[mcp_servers.cypress]'

[mcp_servers.other]
args = [
  ["nested"],
  "[mcp_servers.cypress]",
]
`;
    const result = mergeToml(existing, CODEX, false);
    expect(result).toMatchObject({ status: "update", replaced: false });
    expect(result.text).toBe(`${existing}\n${CODEX_TABLE}`);
  });

  it("escapes Windows paths and quotes, and reads them back as equal", () => {
    const entry = { ...CODEX, args: ["-y", "cypress-mcp", "--cwd", 'C:\\work\\"shop"'] };
    const created = mergeToml(undefined, entry, false).text!;
    expect(created).toContain(
      'args = ["-y", "cypress-mcp", "--cwd", "C:\\\\work\\\\\\"shop\\""]',
    );
    expect(mergeToml(created, entry, false).status).toBe("unchanged");
  });

  it("refuses shapes it would have to rewrite", () => {
    const cases: [string, string][] = [
      ['mcp_servers.cypress.command = "npx"\n', "dotted key or an inline table"],
      ['[mcp_servers]\ncypress = { command = "npx" }\n', "dotted key or an inline table"],
      ['mcp_servers = { other = { command = "x" } }\n', "dotted key or an inline table"],
      [
        '[mcp_servers.cypress]\ncommand = "a"\n[mcp_servers.cypress]\ncommand = "b"\n',
        "[mcp_servers.cypress] twice",
      ],
      ['[[mcp_servers.cypress]]\ncommand = "a"\n', "[[mcp_servers"],
      ["[tui]\nmode = fancy colours\n", "line 2"],
      ['name = "open\n', "line 1"],
    ];
    for (const [text, reason] of cases) {
      const result = mergeToml(text, CODEX, true);
      expect(result.status, text).toBe("refused");
      expect(result.reason, text).toContain(reason);
      expect(result.text, text).toBeUndefined();
    }
  });
});

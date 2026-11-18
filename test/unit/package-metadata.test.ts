import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
  name: string;
  version: string;
  mcpName: string;
};
const server = JSON.parse(readFileSync("server.json", "utf-8")) as {
  name: string;
  version: string;
  packages: { registryType: string; identifier: string; version: string }[];
};

// The MCP Registry rejects a publish when these disagree, after npm already
// has the version, so the mismatch is caught here instead.
describe("server.json for the MCP Registry", () => {
  it("matches package.json", () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toEqual([
      expect.objectContaining({
        registryType: "npm",
        identifier: pkg.name,
        version: pkg.version,
      }),
    ]);
  });
});

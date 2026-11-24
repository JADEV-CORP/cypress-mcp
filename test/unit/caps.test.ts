import { describe, it, expect } from "vitest";
import { CAPABILITIES, parseCaps, unknownCapsWarning } from "../../src/caps.js";

describe("parseCaps", () => {
  it("is empty by default", () => {
    const { caps, unknown } = parseCaps(["--cwd", "/p"], {});
    expect([...caps]).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it("reads --caps a,b, --caps=a and CYPRESS_MCP_CAPS", () => {
    const { caps } = parseCaps(["--caps", "analyze", "--caps=Config"], {
      CYPRESS_MCP_CAPS: " analyze ",
    });
    expect([...caps].sort()).toEqual(["analyze", "config"]);
  });

  it("turns every group on with all", () => {
    const { caps } = parseCaps(["--caps=all"], {});
    expect([...caps].sort()).toEqual(Object.keys(CAPABILITIES).sort());
    expect([...caps].sort()).toEqual(["analyze", "config"]);
  });

  it("reports names that are not a capability", () => {
    const { caps, unknown } = parseCaps(["--caps", "vision,config,constructor"], {});
    expect([...caps]).toEqual(["config"]);
    expect(unknown).toEqual(["vision", "constructor"]);
  });

  it("treats legacy as unknown since 0.5", () => {
    const { caps, unknown } = parseCaps(["--caps", "legacy"], {});
    expect([...caps]).toEqual([]);
    expect(unknown).toEqual(["legacy"]);
  });
});

describe("unknownCapsWarning", () => {
  it("lists the unknown and the known names", () => {
    expect(unknownCapsWarning(["vision"])).toEqual({
      unknown: ["vision"],
      known: ["analyze", "config", "all"],
    });
  });

  it("says legacy was removed in 0.5 and where the replacements are", () => {
    const warning = unknownCapsWarning(["legacy", "vision"]);
    expect(warning).toMatchObject({ unknown: ["legacy", "vision"] });
    expect(warning["note"]).toMatch(/legacy was removed in 0\.5/);
    expect(warning["note"]).toContain("README");
    expect(warning["note"]).toContain("#upgrading");
  });
});

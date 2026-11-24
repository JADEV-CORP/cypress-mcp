// The report check of scripts/audit-prod.mjs, the CI gate on advisories for
// the bundled packages. The script is plain JavaScript run by node.
import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface Checked {
  failures: string[];
  allowed: string[];
}
type CheckReport = (
  report: unknown,
  bundled: ReadonlySet<string>,
  allowed: ReadonlyMap<string, { reason: string }>,
) => Checked;

let checkReport: CheckReport;

beforeAll(async () => {
  const script = pathToFileURL(path.resolve("scripts/audit-prod.mjs")).href;
  ({ checkReport } = (await import(script)) as { checkReport: CheckReport });
});

const metadata = { vulnerabilities: { total: 1 }, dependencies: { total: 270 } };

function advisory(name: string, severity: string, id: string) {
  return {
    name,
    severity,
    title: `${name} issue`,
    url: `https://github.com/advisories/${id}`,
  };
}

describe("checkReport", () => {
  const bundled = new Set(["zod", "tree-kill"]);
  const none = new Map<string, { reason: string }>();

  it("fails a report that says npm audit failed", () => {
    const { failures } = checkReport(
      { message: "request failed", error: { code: "ENOTFOUND", summary: "ENOTFOUND" } },
      bundled,
      none,
    );
    expect(failures).toEqual(["npm audit failed: ENOTFOUND"]);
  });

  it("fails a report without metadata, or no report at all", () => {
    expect(checkReport({ vulnerabilities: {} }, bundled, none).failures).toEqual([
      "npm audit printed a report without metadata, so nothing was audited.",
    ]);
    expect(checkReport(undefined, bundled, none).failures).toEqual([
      "npm audit printed no JSON report.",
    ]);
  });

  it("fails moderate and above on bundled packages, unless allowed", () => {
    const report = {
      vulnerabilities: {
        zod: { via: [advisory("zod", "high", "GHSA-aaaa"), "other"] },
        "tree-kill": { via: [advisory("tree-kill", "moderate", "GHSA-bbbb")] },
        esbuild: { via: [advisory("esbuild", "critical", "GHSA-cccc")] },
      },
      metadata,
    };
    const allowed = new Map([["GHSA-bbbb", { reason: "not reachable" }]]);
    expect(checkReport(report, bundled, allowed)).toEqual({
      failures: ["FAIL     GHSA-aaaa high zod: zod issue"],
      allowed: ["allowed  GHSA-bbbb tree-kill: not reachable"],
    });
  });

  it("passes low advisories and a clean report", () => {
    const report = {
      vulnerabilities: { zod: { via: [advisory("zod", "low", "GHSA-dddd")] } },
      metadata,
    };
    expect(checkReport(report, bundled, none)).toEqual({ failures: [], allowed: [] });
  });
});
